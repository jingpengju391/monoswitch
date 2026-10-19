use crate::model::InputSource;

pub fn input_label(value: u8) -> String {
    match value {
        1 => "VGA 1",
        2 => "VGA 2",
        3 => "DVI 1",
        4 => "DVI 2",
        15 => "DisplayPort 1",
        16 => "DisplayPort 2",
        17 => "HDMI 1",
        18 => "HDMI 2",
        _ => return format!("输入 0x{value:02X}"),
    }
    .into()
}

/// Fallback candidates are not advertised capabilities. Keep the observed input
/// selectable even when a monitor uses a vendor-specific value for VCP 0x60.
pub fn standard_inputs(current: Option<u8>) -> Vec<InputSource> {
    let mut values = vec![15, 16, 17, 18, 3, 4, 1, 2];
    if let Some(current) = current.filter(|value| *value != 0)
        && !values.contains(&current)
    {
        values.push(current);
    }
    values.into_iter().map(source).collect()
}

fn source(value: u8) -> InputSource {
    InputSource {
        value,
        label: input_label(value),
    }
}

/// Parse only the direct children of vcp(...), avoiding e.g. a 60 in another feature's values.
/// Input is bounded by backend output limits; depth scanning uses constant stack space.
pub fn parse_capabilities(text: &str) -> Vec<InputSource> {
    let lower = text.to_ascii_lowercase();
    let Some(start) = lower.find("vcp(") else {
        return Vec::new();
    };
    let bytes = lower.as_bytes();
    let mut at = start + 4;
    while at < bytes.len() {
        while at < bytes.len() && bytes[at].is_ascii_whitespace() {
            at += 1;
        }
        if at == bytes.len() || bytes[at] == b')' {
            break;
        }
        let begin = at;
        while at < bytes.len() && bytes[at].is_ascii_hexdigit() {
            at += 1;
        }
        if begin == at {
            at += 1;
            continue;
        }
        let feature = u8::from_str_radix(&lower[begin..at], 16).ok();
        while at < bytes.len() && bytes[at].is_ascii_whitespace() {
            at += 1;
        }
        if at == bytes.len() || bytes[at] != b'(' {
            continue;
        }
        at += 1;
        let values_start = at;
        let mut depth = 1;
        while at < bytes.len() && depth > 0 {
            match bytes[at] {
                b'(' => depth += 1,
                b')' => depth -= 1,
                _ => {}
            }
            at += 1;
        }
        if depth != 0 {
            return Vec::new();
        }
        if feature == Some(0x60) {
            let mut values: Vec<u8> = lower[values_start..at - 1]
                .split_whitespace()
                .filter_map(|value| u8::from_str_radix(value, 16).ok())
                .filter(|value| *value != 0)
                .collect();
            values.sort_unstable();
            values.dedup();
            return values.into_iter().map(source).collect();
        }
    }
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fallback_includes_second_legacy_ports_and_observed_vendor_input() {
        let inputs = standard_inputs(Some(0x1b));
        let values: Vec<_> = inputs.iter().map(|input| input.value).collect();
        assert_eq!(values, [15, 16, 17, 18, 3, 4, 1, 2, 0x1b]);
        assert_eq!(inputs.last().unwrap().label, "输入 0x1B");
    }
    #[test]
    fn fallback_never_duplicates_current_input_or_adds_zero() {
        let baseline: Vec<_> = standard_inputs(None)
            .iter()
            .map(|input| input.value)
            .collect();
        for current in baseline.iter().copied().chain([0]) {
            let values: Vec<_> = standard_inputs(Some(current))
                .iter()
                .map(|input| input.value)
                .collect();
            assert_eq!(values, baseline);
        }
    }
    #[test]
    fn extracts_only_input_feature_values() {
        let values = parse_capabilities(
            "(prot(monitor)type(LCD)model(Test)vcp(10 14(01 60) 60(0F 11 12 11) D6(01 04)))",
        );
        assert_eq!(
            values.iter().map(|s| s.value).collect::<Vec<_>>(),
            vec![15, 17, 18]
        );
    }
    #[test]
    fn malformed_and_non_input_capabilities_are_empty() {
        for text in [
            "vcp(14(01 60))",
            "vcp(10 60",
            "vcp(60(0F 11",
            "model(60(11))vcp(10)",
            "vcp(60())",
        ] {
            assert!(parse_capabilities(text).is_empty(), "{text}");
        }
    }
}
