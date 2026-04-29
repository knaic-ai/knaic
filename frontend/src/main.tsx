import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, App as AntdApp } from 'antd';
import { BrowserRouter } from 'react-router-dom';
import enUS from 'antd/locale/en_US';
import App from './App';
import { buildTheme } from './theme';
import { AppProvider, useApp } from './context/AppContext';
import './index.css';

function ThemedApp() {
  const { isDark } = useApp();
  return (
    <ConfigProvider theme={buildTheme(isDark)} locale={enUS}>
      <AntdApp>
        <App />
      </AntdApp>
    </ConfigProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AppProvider>
        <ThemedApp />
      </AppProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
