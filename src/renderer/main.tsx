import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initI18n } from './locales/init';
import './styles/globals.css';
import { UserErrorNotice } from './lib/UserErrorNotice';

document.documentElement.dataset.theme = 'dark';
document.documentElement.dataset.platform = /Mac/.test(navigator.platform) ? 'darwin' : /Win/.test(navigator.platform) ? 'win32' : 'linux';
void initI18n().then(() => {
  const root = document.getElementById('root');
  if (!root) throw new Error('Renderer root is missing');
  createRoot(root).render(<App />);
}).catch(error => {
  const root = document.getElementById('root');
  if (root) createRoot(root).render(<UserErrorNotice error={error} />);
});
