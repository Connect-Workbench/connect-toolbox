import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, theme as antdTheme } from 'antd';
import enUS from 'antd/locale/en_US';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import { currentLocale } from './i18n';

// 跟随 VSCode 明暗主题（body class 由 VSCode 注入）
function detectDark(): boolean {
  return document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
}

function Root() {
  const [dark, setDark] = React.useState(detectDark());
  React.useEffect(() => {
    const observer = new MutationObserver(() => setDark(detectDark()));
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return (
    <ConfigProvider
      locale={currentLocale === 'zh-CN' ? zhCN : enUS}
      theme={{
        algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: { borderRadius: 4 },
      }}
    >
      <App />
    </ConfigProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Root />);
