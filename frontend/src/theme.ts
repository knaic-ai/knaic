import { theme as antdTheme, type ThemeConfig } from 'antd';

const baseTokens = {
  colorPrimary: '#2468f2',
  colorInfo: '#2468f2',
  colorSuccess: '#2dbb55',
  colorWarning: '#f8b418',
  colorError: '#e94f4f',
  borderRadius: 2,
  borderRadiusLG: 4,
  borderRadiusSM: 2,
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
  fontSize: 13,
};

export function buildTheme(isDark: boolean): ThemeConfig {
  if (isDark) {
    return {
      algorithm: antdTheme.darkAlgorithm,
      token: {
        ...baseTokens,
        colorBgLayout: '#0f172a',
        colorBgContainer: '#1a2438',
        colorBgElevated: '#1e2a3b',
        colorBorder: '#2a3a52',
        colorBorderSecondary: '#22304a',
      },
      components: {
        Layout: {
          headerBg: '#15202e',
          headerHeight: 48,
          headerPadding: '0 16px',
          siderBg: '#0b1220',
          bodyBg: '#0f172a',
        },
        Menu: {
          darkItemBg: '#0b1220',
          darkSubMenuItemBg: '#0b1220',
          darkItemSelectedBg: '#2468f2',
          darkItemHoverBg: '#17243a',
          itemHeight: 36,
        },
        Table: {
          headerBg: '#15202e',
          headerColor: '#9aa5b5',
          rowHoverBg: '#17243a',
        },
        Button: { controlHeight: 30 },
        Card: { headerBg: '#1a2438' },
      },
    };
  }
  return {
    algorithm: antdTheme.defaultAlgorithm,
    token: {
      ...baseTokens,
      colorBgLayout: '#f3f5f8',
      colorBorder: '#e4e7eb',
      colorBorderSecondary: '#eef0f3',
    },
    components: {
      Layout: {
        headerBg: '#eaf2ff',
        headerHeight: 48,
        headerPadding: '0 16px',
        siderBg: '#1e2a3b',
        triggerBg: '#15202e',
      },
      Menu: {
        darkItemBg: '#1e2a3b',
        darkSubMenuItemBg: '#15202e',
        darkItemSelectedBg: '#2468f2',
        darkItemHoverBg: '#27364c',
        itemHeight: 36,
      },
      Table: {
        headerBg: '#fafbfc',
        headerColor: '#5e6a7a',
        rowHoverBg: '#f5f8ff',
      },
      Card: { headerBg: '#ffffff' },
      Button: { controlHeight: 30 },
      Tag: { defaultBg: '#eef2f7' },
    },
  };
}
