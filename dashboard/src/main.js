import { createApp } from 'vue';
import App from './App.vue';
import './styles/tokens.css';

const stored = localStorage.getItem('ado-kpi-theme');
if (stored) document.documentElement.setAttribute('data-theme', stored);

createApp(App).mount('#app');
