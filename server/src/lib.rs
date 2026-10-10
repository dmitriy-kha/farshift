use axum::{
    extract::{
        ws::{Message, WebSocket},
        State as AxumState, WebSocketUpgrade,
    },
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
mod pairing_code;
use pairing_code::{room_from_index, valid_room, ROOM_CAPACITY};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use std::{
    collections::HashMap,
    env,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, watch, Semaphore};
use tower_http::{services::ServeDir, set_header::SetResponseHeaderLayer};

const MAX_MESSAGE: usize = 64 * 1024;
const PAIRING_SECONDS: u64 = 120;
const MIN_TTL: u64 = 60;
const MAX_TTL: u64 = 999 * 60;
const MAX_PARTICIPANTS: usize = 32768;
const CSP: &str = "default-src 'self'; worker-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

#[derive(Clone)]
pub struct Config {
    pub bind: String,
    pub origin: String,
    pub web_dir: String,
    pub stun_urls: Vec<String>,
    pub turn_urls: Vec<String>,
    pub turn_secret: Option<String>,
    pub relay_only: bool,
    pub max_rooms: usize,
    pub max_connections: usize,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            bind: "127.0.0.1:8080".into(),
            origin: "http://127.0.0.1:8080".into(),
            web_dir: "web".into(),
            stun_urls: vec!["stun:stun.cloudflare.com:3478".into()],
            turn_urls: vec![],
            turn_secret: None,
            relay_only: false,
            max_rooms: MAX_PARTICIPANTS,
            max_connections: MAX_PARTICIPANTS,
        }
    }
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let mut c = Self::default();
        if let Ok(v) = env::var("FARSHIFT_BIND") {
            c.bind = v;
        }
        if let Ok(v) = env::var("FARSHIFT_ORIGIN") {
            c.origin = v;
        }
        if let Ok(v) = env::var("FARSHIFT_WEB_DIR") {
            c.web_dir = v;
        }
        if let Ok(v) = env::var("FARSHIFT_STUN_URLS") {
            c.stun_urls = urls(&v);
        }
        if let Ok(v) = env::var("FARSHIFT_TURN_URLS") {
            c.turn_urls = urls(&v);
        }
        c.turn_secret = env::var("FARSHIFT_TURN_SECRET")
            .ok()
            .filter(|s| !s.is_empty());
        if let Ok(value) = env::var("FARSHIFT_RELAY_ONLY") {
            c.relay_only = match value.as_str() {
                "0" | "false" => false,
                "1" | "true" => true,
                _ => return Err("FARSHIFT_RELAY_ONLY must be 0, false, 1, or true".into()),
            };
        }
        for (name, dest) in [
            ("FARSHIFT_MAX_ROOMS", &mut c.max_rooms),
            ("FARSHIFT_MAX_CONNECTIONS", &mut c.max_connections),
        ] {
            if let Ok(v) = env::var(name) {
                *dest = v.parse().map_err(|_| format!("invalid {name}"))?;
            }
            if *dest == 0 || *dest > MAX_PARTICIPANTS {
                return Err(format!("{name} must be 1..{MAX_PARTICIPANTS}"));
            }
        }
        let origin = c.origin.parse::<axum::http::Uri>().map_err(|_| {
            "FARSHIFT_ORIGIN must be an exact HTTP(S) origin without trailing slash"
        })?;
        let scheme = origin.scheme_str().unwrap_or_default();
        let authority = origin.authority().ok_or("FARSHIFT_ORIGIN needs a host")?;
        let host = authority.host();
        let port = authority.port_u16();
        if !matches!(scheme, "https" | "http")
            || host.is_empty()
            || host != host.to_ascii_lowercase()
            || authority.as_str().contains(['@', '*'])
            || c.origin != format!("{scheme}://{authority}")
            || (authority.as_str() != host && port.is_none())
            || matches!((scheme, port), ("http", Some(80)) | ("https", Some(443)))
        {
            return Err(
                "FARSHIFT_ORIGIN must be an exact HTTP(S) origin without trailing slash".into(),
            );
        }
        if c.stun_urls
            .iter()
            .any(|u| !u.starts_with("stun:") && !u.starts_with("stuns:"))
            || c.turn_urls
                .iter()
                .any(|u| !u.starts_with("turn:") && !u.starts_with("turns:"))
        {
            return Err("invalid STUN/TURN URL scheme".into());
        }
        if (!c.turn_urls.is_empty() && c.turn_secret.is_none())
            || (c.relay_only && c.turn_urls.is_empty())
        {
            return Err(
                "TURN needs FARSHIFT_TURN_URLS and FARSHIFT_TURN_SECRET; relay-only needs TURN"
                    .into(),
            );
        }
        Ok(c)
    }
    fn ice_servers(&self, expires_at: u64, connection: &str) -> Vec<IceServer> {
        let mut result = Vec::new();
        if !self.stun_urls.is_empty() {
            result.push(IceServer {
                urls: self.stun_urls.clone(),
                username: None,
                credential: None,
            });
        }
        if let Some(secret) = &self.turn_secret {
            if !self.turn_urls.is_empty() {
                let username = format!("{}:{}", expires_at.div_ceil(1000), connection);
                let mut hmac = Hmac::<Sha1>::new_from_slice(secret.as_bytes())
                    .expect("HMAC accepts any key length");
                hmac.update(username.as_bytes());
                result.push(IceServer {
                    urls: self.turn_urls.clone(),
                    username: Some(username),
                    credential: Some(STANDARD.encode(hmac.finalize().into_bytes())),
                });
            }
        }
        result
    }
}
fn urls(s: &str) -> Vec<String> {
    s.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn random_id() -> Result<String, &'static str> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|_| "randomness unavailable")?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn allowed_origin(h: &HeaderMap, origin: &str) -> bool {
    h.get_all("origin").iter().count() == 1
        && h.get("origin").and_then(|h| h.to_str().ok()) == Some(origin)
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Input {
    Create { ttl: u64, ttl_explicit: bool },
    Select { peer: String },
    Relay { payload: String },
    Paired {},
    Invalidate {},
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Output {
    Ready {
        room: String,
        expires_at: u64,
        pairing_deadline: u64,
        ice_servers: Vec<IceServer>,
        relay_only: bool,
    },
    PeerReady {
        peer: String,
        attempt: String,
        role: &'static str,
        expires_at: u64,
        pairing_deadline: u64,
    },
    Relay {
        payload: String,
    },
    Error {
        message: &'static str,
    },
    Closed {
        reason: &'static str,
    },
}
#[derive(Clone, Debug, Serialize)]
struct IceServer {
    urls: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    credential: Option<String>,
}
struct Peer {
    tx: mpsc::Sender<Output>,
    close: watch::Sender<Option<&'static str>>,
    paired: bool,
}
struct Room {
    code: String,
    code_index: usize,
    peer: Peer,
    selected: Option<u64>,
    matched: Option<u64>,
    expires: Instant,
    pairing: Instant,
    expires_at: u64,
    pairing_deadline: u64,
    ttl_explicit: bool,
}
#[derive(Clone)]
pub struct State {
    inner: Arc<Inner>,
}
struct Inner {
    next_generation: AtomicU64,
    room_cursor: AtomicU64,
    admissions: Mutex<AdmissionBucket>,
    config: Config,
    registry: Mutex<Registry>,
    connections: Arc<Semaphore>,
    shutdown: watch::Sender<bool>,
}
struct Registry {
    rooms: HashMap<u64, Room>,
    pending: HashMap<String, u64>,
    reservations: Vec<Option<Instant>>,
}
impl Registry {
    fn release_code(&mut self, id: u64) {
        let Some(room) = self.rooms.get(&id) else {
            return;
        };
        // A repeated confirmation from an old connection must not release a new owner.
        if self.pending.get(&room.code) == Some(&id) {
            self.pending.remove(&room.code);
            self.reservations[room.code_index] = None;
        }
    }
    fn remove(&mut self, id: u64, reason: &'static str) {
        let Some(room) = self.rooms.remove(&id) else {
            return;
        };
        if self.pending.get(&room.code) == Some(&id) {
            self.pending.remove(&room.code);
        }
        // Failed and abandoned codes retain their original two-minute reservation.
        let _ = room.peer.close.send(Some(reason));
        if let Some(other) = room.matched {
            if self.rooms.get(&other).is_some_and(|r| r.matched == Some(id)) {
                let partner = self.rooms.remove(&other).unwrap();
                if self.pending.get(&partner.code) == Some(&other) {
                    self.pending.remove(&partner.code);
                }
                let _ = partner.peer.close.send(Some(reason));
            }
        }
    }
}
struct AdmissionBucket {
    tokens: f64,
    updated: Instant,
}
impl AdmissionBucket {
    fn take(&mut self, now: Instant) -> bool {
        self.tokens = (self.tokens
            + now.saturating_duration_since(self.updated).as_secs_f64() * 10.0)
            .min(20.0);
        self.updated = now;
        if self.tokens < 1.0 {
            return false;
        }
        self.tokens -= 1.0;
        true
    }
}
impl State {
    pub fn new(config: Config) -> Self {
        let (shutdown, _) = watch::channel(false);
        Self {
            inner: Arc::new(Inner {
                next_generation: AtomicU64::new(1),
                room_cursor: AtomicU64::new(0),
                admissions: Mutex::new(AdmissionBucket {
                    tokens: 20.0,
                    updated: Instant::now(),
                }),
                connections: Arc::new(Semaphore::new(config.max_connections)),
                shutdown,
                config,
                registry: Mutex::new(Registry {
                    rooms: HashMap::new(),
                    pending: HashMap::new(),
                    reservations: vec![None; ROOM_CAPACITY],
                }),
            }),
        }
    }
    pub fn shutdown(&self) {
        self.inner.shutdown.send_replace(true);
        self.inner.connections.close();
    }
    pub fn expire(&self) {
        let mut registry = self.inner.registry.lock().unwrap();
        let now = Instant::now();
        let expired: Vec<_> = registry
            .rooms
            .iter()
            .filter_map(|(id, room)| {
                let reason = if now >= room.expires {
                    Some("expired")
                } else if now >= room.pairing && !room.peer.paired {
                    Some("pairing_timeout")
                } else {
                    None
                };
                reason.map(|reason| (*id, reason))
            })
            .collect();
        for (id, reason) in expired {
            registry.remove(id, reason);
        }
    }
    fn remove(&self, id: u64, reason: &'static str) {
        self.inner.registry.lock().unwrap().remove(id, reason);
    }
    fn admit(&self, input: Input, peer: Peer) -> Result<u64, &'static str> {
        if *self.inner.shutdown.borrow() {
            return Err("server shutting down");
        }
        if !self.inner.admissions.lock().unwrap().take(Instant::now()) {
            return Err("admission rate limit");
        }
        self.expire();
        let Input::Create { ttl, ttl_explicit } = input else {
            return Err("create required");
        };
        if !(MIN_TTL..=MAX_TTL).contains(&ttl) || (!ttl_explicit && ttl != 60 * 60) {
            return Err("invalid lifetime");
        }
        let mut registry = self.inner.registry.lock().unwrap();
        if registry.rooms.len() >= self.inner.config.max_rooms {
            return Err("server full");
        }
        let start = self.inner.room_cursor.load(Ordering::Relaxed) as usize % ROOM_CAPACITY;
        let allocated_at = Instant::now();
        let pairing = allocated_at + Duration::from_secs(ttl.min(PAIRING_SECONDS));
        let (number, code) = (0..ROOM_CAPACITY)
            .find_map(|offset| {
                let number = (start + offset) % ROOM_CAPACITY;
                let code = room_from_index(number).expect("index is within room capacity");
                (!registry.pending.contains_key(&code)
                    && !registry.reservations[number].is_some_and(|until| until > allocated_at))
                .then_some((number, code))
            })
            .ok_or("server full")?;
        let now = now_ms();
        let id = self
            .inner
            .next_generation
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                value.checked_add(1)
            })
            .map_err(|_| "session identifier limit")?;
        let expires_at = now + ttl * 1000;
        let pairing_deadline = now + ttl.min(PAIRING_SECONDS) * 1000;
        peer.tx
            .try_send(Output::Ready {
                room: code.clone(),
                expires_at,
                pairing_deadline,
                // TURN accounts remain distinct when a public code is recycled.
                ice_servers: self.inner.config.ice_servers(
                    if ttl_explicit {
                        expires_at
                    } else {
                        now + (MAX_TTL + PAIRING_SECONDS) * 1000
                    },
                    &random_id()?,
                ),
                relay_only: self.inner.config.relay_only,
            })
            .map_err(|_| "connection unavailable")?;
        registry.reservations[number] = Some(allocated_at + Duration::from_secs(PAIRING_SECONDS));
        registry.pending.insert(code.clone(), id);
        self.inner
            .room_cursor
            .store(((number + 1) % ROOM_CAPACITY) as u64, Ordering::Relaxed);
        registry.rooms.insert(
            id,
            Room {
                code,
                code_index: number,
                peer,
                selected: None,
                matched: None,
                expires: allocated_at + Duration::from_secs(ttl),
                pairing,
                expires_at,
                pairing_deadline,
                ttl_explicit,
            },
        );
        Ok(id)
    }
    fn process(&self, id: u64, input: Input) -> Result<(), &'static str> {
        let mut registry = self.inner.registry.lock().unwrap();
        let now = Instant::now();
        let matched = registry.rooms.get(&id).and_then(|room| room.matched);
        let selected = match &input {
            Input::Select { peer } => registry.pending.get(peer).copied(),
            _ => None,
        };
        // Check only the rooms involved; the periodic sweeper handles all others.
        for candidate in [Some(id), matched, selected].into_iter().flatten() {
            let reason = registry.rooms.get(&candidate).and_then(|room| {
                if now >= room.expires {
                    Some("expired")
                } else if now >= room.pairing && !room.peer.paired {
                    Some("pairing_timeout")
                } else {
                    None
                }
            });
            if let Some(reason) = reason {
                registry.remove(candidate, reason);
            }
        }
        let room = registry.rooms.get(&id).ok_or("room unavailable")?;
        match input {
            Input::Select { peer } => {
                if !valid_room(&peer) || peer == room.code {
                    return Err("invalid peer");
                }
                if room.selected.is_some() || room.matched.is_some() {
                    return Err("selection already used");
                }
                let other_id = *registry.pending.get(&peer).ok_or("peer unavailable")?;
                let other = registry
                    .rooms
                    .get(&other_id)
                    .filter(|r| r.matched.is_none())
                    .ok_or("peer unavailable")?;
                let mutual = other.selected == Some(id);
                registry.rooms.get_mut(&id).unwrap().selected = Some(other_id);
                if !mutual {
                    return Ok(());
                }
                let attempt = random_id()?;
                let rooms = &mut registry.rooms;
                let own_code = rooms[&id].code.clone();
                let lifetime_rooms = match (rooms[&id].ttl_explicit, rooms[&other_id].ttl_explicit) {
                    (true, false) => [id, id],
                    (false, true) => [other_id, other_id],
                    _ => [id, other_id],
                };
                let expires_at = rooms[&lifetime_rooms[0]]
                    .expires_at
                    .min(rooms[&lifetime_rooms[1]].expires_at);
                let pairing_deadline = rooms[&id]
                    .pairing_deadline
                    .min(rooms[&other_id].pairing_deadline);
                let expires = rooms[&lifetime_rooms[0]]
                    .expires
                    .min(rooms[&lifetime_rooms[1]].expires);
                let pairing = rooms[&id].pairing.min(rooms[&other_id].pairing);
                for (own, other, peer_code, role) in [
                    (
                        id,
                        other_id,
                        peer.clone(),
                        if own_code < peer { "a" } else { "b" },
                    ),
                    (
                        other_id,
                        id,
                        own_code.clone(),
                        if peer < own_code { "a" } else { "b" },
                    ),
                ] {
                    let room = registry.rooms.get_mut(&own).unwrap();
                    room.matched = Some(other);
                    room.expires_at = expires_at;
                    room.pairing_deadline = pairing_deadline;
                    room.expires = expires;
                    room.pairing = pairing;
                    if room
                        .peer
                        .tx
                        .try_send(Output::PeerReady {
                            peer: peer_code,
                            attempt: attempt.clone(),
                            role,
                            expires_at,
                            pairing_deadline,
                        })
                        .is_err()
                    {
                        registry.remove(own, "connection unavailable");
                        registry.remove(other, "connection unavailable");
                        return Err("connection unavailable");
                    }
                }
                Ok(())
            }
            Input::Relay { payload } if payload.len() <= 48 * 1024 => {
                let other_id = room.matched.ok_or("mutual selection required")?;
                let other = registry
                    .rooms
                    .get(&other_id)
                    .filter(|r| r.matched == Some(id))
                    .ok_or("peer unavailable")?;
                other
                    .peer
                    .tx
                    .try_send(Output::Relay { payload })
                    .map_err(|_| "peer too slow")
            }
            Input::Paired {} if room.matched.is_some() => {
                let other_id = room.matched.unwrap();
                let other = registry
                    .rooms
                    .get(&other_id)
                    .filter(|r| r.matched == Some(id))
                    .ok_or("peer unavailable")?;
                let both_paired = other.peer.paired;
                registry.rooms.get_mut(&id).unwrap().peer.paired = true;
                if both_paired {
                    registry.release_code(id);
                    registry.release_code(other_id);
                }
                Ok(())
            }
            Input::Invalidate {} => Err("code invalidated"),
            _ => Err("invalid message"),
        }
    }
}

pub fn app(state: State) -> Router {
    let web_dir = state.inner.config.web_dir.clone();
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/ws", get(upgrade))
        .fallback_service(ServeDir::new(web_dir).append_index_html_on_directories(true))
        .layer(SetResponseHeaderLayer::overriding(
            axum::http::header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(CSP),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            axum::http::header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            axum::http::header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            axum::http::header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ))
        .with_state(state)
}
async fn upgrade(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if *state.inner.shutdown.borrow() {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    if !allowed_origin(&headers, &state.inner.config.origin) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Ok(permit) = state.inner.connections.clone().try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    ws.max_message_size(MAX_MESSAGE)
        .max_frame_size(MAX_MESSAGE)
        .read_buffer_size(16 * 1024)
        .write_buffer_size(0)
        .max_write_buffer_size(MAX_MESSAGE * 2)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            session(socket, state).await
        })
        .into_response()
}
async fn send(socket: &mut WebSocket, output: Output) -> bool {
    let message = Message::Text(serde_json::to_string(&output).unwrap().into());
    send_frame(socket, message).await
}
async fn send_frame(socket: &mut WebSocket, message: Message) -> bool {
    matches!(
        tokio::time::timeout(Duration::from_secs(5), socket.send(message)).await,
        Ok(Ok(()))
    )
}
async fn session(mut socket: WebSocket, state: State) {
    let mut shutdown = state.inner.shutdown.subscribe();
    if *shutdown.borrow() {
        return;
    }
    let input = tokio::select! {
        _ = shutdown.changed() => return,
        incoming = tokio::time::timeout(Duration::from_secs(10), socket.recv()) => {
            match incoming {
                Ok(Some(Ok(Message::Text(s)))) => serde_json::from_str::<Input>(&s).ok(),
                _ => None,
            }
        }
    };
    let Some(input) = input else {
        send(
            &mut socket,
            Output::Error {
                message: "create required",
            },
        )
        .await;
        return;
    };
    let (tx, mut rx) = mpsc::channel(8);
    let (close, mut closed) = watch::channel(None);
    let peer = Peer {
        tx,
        close,
        paired: false,
    };
    let id = match state.admit(input, peer) {
        Ok(v) => v,
        Err(message) => {
            send(&mut socket, Output::Error { message }).await;
            return;
        }
    };
    let mut window = Instant::now();
    let mut messages = 0;
    let mut last_received = Instant::now();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    heartbeat.tick().await;
    loop {
        if *shutdown.borrow() || last_received.elapsed() >= Duration::from_secs(90) {
            break;
        }
        tokio::select! {
            _ = shutdown.changed() => break,
            _ = heartbeat.tick() => {
                if last_received.elapsed() >= Duration::from_secs(90)
                    || !send_frame(&mut socket, Message::Ping(Default::default())).await {
                    break;
                }
            }
            changed = closed.changed() => {
                if changed.is_ok() { let reason = *closed.borrow(); if let Some(reason) = reason { send(&mut socket, Output::Closed { reason }).await; } }
                break;
            }
            outgoing = rx.recv() => {
                if let Some(output) = outgoing { if !send(&mut socket, output).await { break; } } else { break; }
            }
            incoming = socket.recv() => {
                last_received = Instant::now();
                if window.elapsed() >= Duration::from_secs(1) { window = Instant::now(); messages = 0; }
                messages += 1;
                if messages > 100 { send(&mut socket, Output::Error { message: "rate limit" }).await; break; }
                match incoming {
                    Some(Ok(Message::Text(s))) => {
                        let result = serde_json::from_str::<Input>(&s).map_err(|_| "invalid message").and_then(|input| state.process(id, input));
                        if let Err(message) = result { send(&mut socket, Output::Error { message }).await; break; }
                    }
                    Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {},
                    _ => break,
                }
            }
        }
    }
    state.remove(id, "peer_disconnected");
    let _ = tokio::time::timeout(Duration::from_secs(1), socket.send(Message::Close(None))).await;
}
