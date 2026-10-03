// NEXUS: PixiJS without eval, so the world runs under NEXUS's strict CSP (no 'unsafe-eval').
import '@pixi/unsafe-eval';
import React from 'react';
import ReactDOM from 'react-dom/client';
import Home from './App.tsx';
import './index.css';
import 'uplot/dist/uPlot.min.css';
import 'react-toastify/dist/ReactToastify.css';
import ConvexClientProvider from './components/ConvexClientProvider.tsx';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConvexClientProvider>
      <Home />
    </ConvexClientProvider>
  </React.StrictMode>,
);
