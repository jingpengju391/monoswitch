set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
case "$1" in
  pacman) pacman -S --needed --noconfirm deskflow ;;
  apt) apt-get update; apt-get install -y --no-remove --no-install-recommends deskflow ;;
  dnf) dnf install -y deskflow ;;
  zypper) zypper --non-interactive install --no-recommends deskflow ;;
  *) printf '%s\n' 'Automatic installation is unavailable. Install Deskflow 1.26 or newer from https://github.com/deskflow/deskflow/releases' >&2; exit 1 ;;
esac
