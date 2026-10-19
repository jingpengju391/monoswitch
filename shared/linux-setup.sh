#!/bin/sh
# Fixed, bundled operation. No user paths or shell fragments are accepted.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 022
mkdir -p -m 700 /run/monoswitch
exec 9>/run/monoswitch/setup.lock
flock -n 9 || { echo 'Another MonoSwitch system setup is running.' >&2; exit 3; }

if ! command -v ddcutil >/dev/null 2>&1; then
  case "$1" in
    pacman) pacman -S --needed --noconfirm ddcutil ;;
    apt) apt-get update; apt-get install -y --no-remove --no-install-recommends ddcutil ;;
    dnf) dnf install -y ddcutil ;;
    zypper) zypper --non-interactive install --no-recommends ddcutil ;;
    *) echo 'This distribution requires manual installation of ddcutil.' >&2; exit 2 ;;
  esac
fi

# A failure here must not be reported as a successful setup.
modprobe i2c-dev
mkdir -p /etc/modules-load.d
printf 'i2c-dev\n' > /etc/modules-load.d/monoswitch-i2c.conf

# Limit access to video-controller buses and the active local session.
# Keep the distribution's packaged rules; supplement only if absent.
if [ ! -f /usr/lib/udev/rules.d/60-ddcutil-i2c.rules ] && [ ! -f /etc/udev/rules.d/60-ddcutil-i2c.rules ]; then
  mkdir -p /etc/udev/rules.d
  printf '%s\n' 'SUBSYSTEM=="i2c-dev", KERNEL=="i2c-[0-9]*", ATTRS{class}=="0x03*", TAG+="uaccess"' > /etc/udev/rules.d/60-monoswitch-i2c.rules
fi
udevadm control --reload-rules
udevadm trigger --action=add --subsystem-match=i2c-dev
udevadm settle --timeout=15
