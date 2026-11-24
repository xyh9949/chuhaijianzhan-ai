import type { CSSProperties } from 'react';
import type { ThemeConfig } from 'antd';

// Ant token 与 CSS 变量共用此来源；客户网站的 SiteTheme 独立管理。
export const adminTokens = {
  primary: '#165DFF', primaryHover: '#0F4CDC', primarySoft: '#EDF3FF',
  text: '#15253D', muted: '#65758B', background: '#F3F6FA', surface: '#FFFFFF',
  border: '#E2E8F0', navy: '#13263B', success: '#15805A', warning: '#AE6414', error: '#D43838',
  font: 'Manrope, "Source Han Sans SC", "Microsoft YaHei", sans-serif',
} as const;
export const adminCssVars = {
  '--primary': adminTokens.primary, '--primary-hover': adminTokens.primaryHover,
  '--primary-soft': adminTokens.primarySoft, '--text': adminTokens.text, '--muted': adminTokens.muted,
  '--bg': adminTokens.background, '--surface': adminTokens.surface, '--border': adminTokens.border,
  '--navy': adminTokens.navy, '--warm': adminTokens.warning, '--warm-soft': '#FFF7E8',
  '--radius': '8px', '--shadow': '0 2px 5px #15253d04', '--font-admin': adminTokens.font,
} as CSSProperties;
const sidebarColors = { text: '#E5EDF7', hover: '#20374E', active: '#28415A' };
// 侧栏是暗色区域；使用Ant原生状态token，避免浅色Button悬停规则后注入时把文字改暗。
export const sidebarTheme: ThemeConfig = {
  components: { Button: {
    textTextColor: sidebarColors.text, textTextHoverColor: '#FFFFFF', textTextActiveColor: '#FFFFFF',
    textHoverBg: sidebarColors.hover, colorFill: sidebarColors.active,
    defaultBg: '#162B41', defaultColor: '#F4F7FC', defaultBorderColor: '#39516A',
    defaultHoverBg: sidebarColors.hover, defaultHoverColor: '#FFFFFF', defaultHoverBorderColor: '#5D7792',
    defaultActiveBg: sidebarColors.active, defaultActiveColor: '#FFFFFF', defaultActiveBorderColor: '#5D7792',
  }, Menu: {
    darkItemColor: sidebarColors.text, darkItemHoverColor: '#FFFFFF', darkItemHoverBg: sidebarColors.hover,
    darkItemSelectedColor: '#FFFFFF', darkItemSelectedBg: adminTokens.primary,
  } },
};
export const adminTheme: ThemeConfig = {
  token: {
    colorPrimary: adminTokens.primary, colorLink: adminTokens.primary, colorInfo: adminTokens.primary,
    colorSuccess: adminTokens.success, colorWarning: adminTokens.warning, colorError: adminTokens.error,
    colorText: adminTokens.text, colorTextSecondary: adminTokens.muted, colorBgLayout: adminTokens.background,
    colorBorder: adminTokens.border, colorSplit: adminTokens.border, borderRadius: 6, controlHeight: 36,
    fontSize: 14, fontFamily: adminTokens.font, fontWeightStrong: 600,
    boxShadow: '0 8px 28px #15253d12', boxShadowSecondary: '0 12px 40px #15253d16',
  },
  components: {
    Button: { primaryShadow: 'none', defaultShadow: 'none', fontWeight: 500 },
    Menu: { itemHeight: 44, itemBorderRadius: 6, itemSelectedBg: adminTokens.primarySoft,
      itemSelectedColor: adminTokens.primary, darkItemBg: adminTokens.navy,
      darkItemColor: '#C5D2E0', darkItemHoverBg: '#20374E', darkItemSelectedBg: adminTokens.primary },
    Table: { headerBg: '#F5F7FB', headerColor: adminTokens.muted, headerSplitColor: 'transparent',
      cellPaddingBlock: 15, cellPaddingInline: 20, rowHoverBg: '#F8FAFD' },
    Tabs: { titleFontSize: 14, horizontalItemGutter: 28 },
    Modal: { titleFontSize: 18, borderRadiusLG: 10 },
    Form: { labelColor: adminTokens.text, labelFontSize: 14, itemMarginBottom: 22 },
    Input: { activeShadow: '0 0 0 3px #165dff12' },
    Select: { optionSelectedBg: adminTokens.primarySoft },
    Tag: { defaultBg: '#F4F6FA', defaultColor: adminTokens.muted },
  },
};
