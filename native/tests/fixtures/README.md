# Parser fixture provenance

- `ddcutil-detect.txt`: two displays from the official [`detect --brief` example](https://www.ddcutil.com/command_detect/); an invalid-display record was added to test filtering.
- `betterdisplay-identifiers.json`: JSON display identifier payload reported in [BetterDisplay issue #5350](https://github.com/waydabber/BetterDisplay/issues/5350), formatted without semantic changes. This fixture verifies parsing, not that this monitor supports standard VCP 0x60 switching; the issue specifically concerns hardware incompatibility.

DDC terse value format follows [ddcutil getvcp documentation](https://www.ddcutil.com/command_getvcp/). Capability parsing follows the raw string returned by [`capabilities --terse`](https://www.ddcutil.com/command_capabilities/). BetterDisplay arguments follow the [official CLI reference](https://betterdisplay.pro/guide/integration/cli-reference/). Its companion's [source](https://github.com/waydabber/betterdisplaycli/blob/main/betterdisplaycli.swift) prints the response payload and exits nonzero on failure; successful writes may have no stdout.
