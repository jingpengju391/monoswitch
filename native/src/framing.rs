use std::io::{self, Read, Write};

pub const MAX_REQUEST: usize = 128 * 1024;
const MAX_RESPONSE: usize = 1024 * 1024;

pub fn read_frame(reader: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut header = [0_u8; 4];
    // EOF before a header is normal. An incomplete header/body is an error.
    loop {
        match reader.read(&mut header[..1]) {
            Ok(0) => return Ok(None),
            Ok(_) => break,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    reader.read_exact(&mut header[1..])?;
    let length = u32::from_ne_bytes(header) as usize;
    if length == 0 || length > MAX_REQUEST {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid native message length",
        ));
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    Ok(Some(body))
}

pub fn write_frame(writer: &mut impl Write, value: &serde_json::Value) -> io::Result<()> {
    let body = serde_json::to_vec(value)?;
    if body.len() > MAX_RESPONSE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Native response exceeds 1 MiB",
        ));
    }
    writer.write_all(&(body.len() as u32).to_ne_bytes())?;
    writer.write_all(&body)?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clean_eof_and_roundtrip() {
        assert!(read_frame(&mut &[][..]).unwrap().is_none());
        let mut frame = Vec::new();
        let expected = serde_json::json!({"message":"你好"});
        write_frame(&mut frame, &expected).unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(
                &read_frame(&mut frame.as_slice()).unwrap().unwrap()
            )
            .unwrap(),
            expected
        );
    }
    #[test]
    fn truncated_header_or_body() {
        assert_eq!(
            read_frame(&mut &[1_u8, 0][..]).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
        let mut frame = 10_u32.to_ne_bytes().to_vec();
        frame.extend_from_slice(b"{}");
        assert_eq!(
            read_frame(&mut frame.as_slice()).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
    }
    #[test]
    fn rejects_oversized_and_empty_frame_without_allocating() {
        for length in [0_u32, MAX_REQUEST as u32 + 1, u32::MAX] {
            assert_eq!(
                read_frame(&mut length.to_ne_bytes().as_slice())
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::InvalidData
            );
        }
    }
}
