import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './app/App.vue';
import router from './app/router.js';

const pinia = createPinia();
const app = createApp(App);
app.use(pinia);
app.use(router);
app.mount('#app');
