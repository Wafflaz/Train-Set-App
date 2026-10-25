import { defineConfig } from 'vite';
import { phoneLink } from './vite-phone';

export default defineConfig({ server: { port: 5173 }, plugins: [phoneLink()] });
