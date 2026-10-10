use farshift_server::{app, Config, State};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env()?;
    let listener = tokio::net::TcpListener::bind(&config.bind).await?;
    eprintln!("farshift listening on {}", listener.local_addr()?);
    let state = State::new(config);
    let shutdown = state.clone();
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let sweeper = state.clone();
    tokio::spawn(async move {
        let mut timer = tokio::time::interval(std::time::Duration::from_secs(1));
        loop {
            timer.tick().await;
            sweeper.expire();
        }
    });
    axum::serve(listener, app(state))
        .with_graceful_shutdown(async move {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {},
                _ = terminate.recv() => {},
            }
            shutdown.shutdown();
        })
        .await?;
    Ok(())
}
