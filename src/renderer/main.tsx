import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initI18n } from './locales/init';
import { installGlassSpecular } from './lib/glass/specular';
import './styles/globals.css';
import './app/shell.css';

document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
document.documentElement.dataset.platform = /Mac/.test(navigator.platform) ? 'darwin' : /Win/.test(navigator.platform) ? 'win32' : 'linux';
const uninstallGlassSpecular = installGlassSpecular();
if (import.meta.hot) import.meta.hot.dispose(uninstallGlassSpecular);
void initI18n().then(() => {
  const root = document.getElementById('root');
  if (!root) throw new Error('Renderer root is missing');
  createRoot(root).render(<App />);
}).catch(error => {
  const root = document.getElementById('root');
  if (root) root.textContent = `Unable to initialize OMP-Desktop: ${String(error)}`;
});
