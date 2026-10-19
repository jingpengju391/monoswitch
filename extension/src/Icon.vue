<script setup lang="ts">
withDefaults(
  defineProps<{
    name:
      | 'monitor'
      | 'arrow'
      | 'settings'
      | 'refresh'
      | 'check'
      | 'copy'
      | 'link'
      | 'close'
      | 'info'
      | 'laptop'
      | 'external'
    size?: number
  }>(),
  { size: 20 },
)
const paths = {
  monitor: [
    'M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z',
    'M8 21h8M12 17v4',
  ],
  arrow: ['M4 12h16m-6-6 6 6-6 6'],
  settings: ['M4 7h16M4 17h16', 'M8 4v6M16 14v6'],
  refresh: [
    'M20 7v5h-5',
    'M20 12a8 8 0 1 0-2.35 5.65M20 7l-2.35-2.65A8 8 0 0 0 12 3',
  ],
  check: ['m5 12 4 4L19 6'],
  copy: ['M9 9h11v12H9z', 'M5 15H3V3h12v2'],
  link: [
    'm10 13 4-4',
    'M8 15 6 17a3 3 0 0 1-4-4l4-4a3 3 0 0 1 4 0',
    'm14 15 4-4a3 3 0 0 0-4-4l-2 2',
  ],
  close: ['m6 6 12 12M6 18 18 6'],
  info: ['M12 11v6M12 7v.01', 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0'],
  laptop: ['M5 4h14v12H5z', 'M2 20h20l-3-4H5z'],
  external: ['M14 3h7v7M21 3l-9 9', 'M10 3H3v18h18v-7'],
}
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.65"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-for="(path, index) in paths[name]" :key="index" :d="path" />
  </svg>
</template>
