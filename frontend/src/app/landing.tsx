import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Landing } from '@/components/landing/Landing';
import { Providers } from '@/components/Providers';
import './styles/globals.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing from home.html');

createRoot(root).render(
  <StrictMode>
    <Providers>
      <Landing />
    </Providers>
  </StrictMode>,
);
