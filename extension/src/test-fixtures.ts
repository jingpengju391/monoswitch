import type { HostStatus, Settings } from '../../shared/protocol'

export function fixtures(): { status: HostStatus; settings: Settings } {
  return {
    status: {
      version: '0.1.0',
      platform: {
        os: 'linux',
        arch: 'x86_64',
        hostname: 'local',
        distribution: 'Manjaro Linux',
      },
      backend: { name: 'ddcutil', available: true },
      displays: [
        {
          id: 'monitor-1',
          name: 'Test monitor',
          serial: '123',
          currentInput: 15,
          inputs: [
            { value: 15, label: 'DP 1' },
            { value: 17, label: 'HDMI 1' },
          ],
          inputDetection: 'reported',
          canSwitch: true,
        },
      ],
      warnings: [],
    },
    settings: {
      displayId: 'monitor-1',
      localName: 'Workstation',
      localInput: 15,
      peer: {
        version: 1,
        name: 'MacBook',
        platform: { os: 'macos', arch: 'aarch64', hostname: 'remote' },
        input: 17,
        monitor: { name: 'Test monitor', serial: '123' },
      },
    },
  }
}
