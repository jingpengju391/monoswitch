import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
import { initLocale } from './i18n'

void initLocale().then(() => createApp(App).mount('#app'))
