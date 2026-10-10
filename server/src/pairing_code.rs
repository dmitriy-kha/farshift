const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ROOM_CHARS: usize = 3;
pub const ROOM_CAPACITY: usize = 32usize.pow(ROOM_CHARS as u32);

pub fn valid_room(room: &str) -> bool {
    room.len() == ROOM_CHARS && room.bytes().all(|byte| ALPHABET.contains(&byte))
}

pub fn room_from_index(mut index: usize) -> Result<String, ()> {
    if index >= ROOM_CAPACITY {
        return Err(());
    }
    let mut room = [b'0'; ROOM_CHARS];
    for symbol in room.iter_mut().rev() {
        *symbol = ALPHABET[index % ALPHABET.len()];
        index /= ALPHABET.len();
    }
    Ok(String::from_utf8(room.to_vec()).expect("ASCII alphabet"))
}
