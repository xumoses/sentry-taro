import { defineConfig, type DefaultTheme } from 'vitepress';

const repo = 'https://github.com/xumoses/sentry-taro';

function zhSidebar(): DefaultTheme.SidebarItem[] {
  return [
    {
      text: '入门',
      items: [
        { text: '快速开始', link: '/guide/getting-started' },
        { text: '核心概念', link: '/guide/concepts' },
      ],
    },
    {
      text: '指南',
      items: [
        { text: 'Session Replay', link: '/guide/replay' },
        { text: 'Taro 构建插件', link: '/guide/taro-plugin' },
        { text: 'Worker 压缩', link: '/guide/worker' },
        { text: '原生与 Taro 混合应用', link: '/guide/hybrid-apps' },
      ],
    },
    {
      text: '参考',
      items: [
        { text: 'API 与配置', link: '/guide/api' },
        { text: '从旧包迁移', link: '/guide/migration' },
        { text: '常见问题', link: '/guide/faq' },
      ],
    },
  ];
}

function enSidebar(): DefaultTheme.SidebarItem[] {
  return [
    {
      text: 'Introduction',
      items: [
        { text: 'Getting started', link: '/en/guide/getting-started' },
        { text: 'Core concepts', link: '/en/guide/concepts' },
      ],
    },
    {
      text: 'Guides',
      items: [
        { text: 'Session Replay', link: '/en/guide/replay' },
        { text: 'Taro build plugin', link: '/en/guide/taro-plugin' },
        { text: 'Worker compression', link: '/en/guide/worker' },
        { text: 'Hybrid native + Taro apps', link: '/en/guide/hybrid-apps' },
      ],
    },
    {
      text: 'Reference',
      items: [
        { text: 'API and configuration', link: '/en/guide/api' },
        { text: 'Migrating from legacy packages', link: '/en/guide/migration' },
        { text: 'FAQ', link: '/en/guide/faq' },
      ],
    },
  ];
}

export default defineConfig({
  title: 'Sentry for Taro',
  cleanUrls: true,
  lastUpdated: false,
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/logo.svg' }]],
  themeConfig: {
    logo: '/logo.svg',
    socialLinks: [{ icon: 'github', link: repo }],
    search: { provider: 'local' },
  },
  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      description: '面向 Taro React 微信小程序的社区 Sentry SDK',
      themeConfig: {
        nav: [
          { text: '快速开始', link: '/guide/getting-started' },
          { text: '核心概念', link: '/guide/concepts' },
          {
            text: '使用文档',
            link: '/guide/replay',
            activeMatch: '^/guide/(?!getting-started|concepts)',
          },
          { text: 'CHANGELOG', link: `${repo}/blob/main/CHANGELOG.md` },
        ],
        sidebar: { '/guide/': zhSidebar() },
        editLink: {
          pattern: `${repo}/edit/main/website/:path`,
          text: '在 GitHub 上编辑此页',
        },
        outline: { label: '本页目录', level: [2, 3] },
        docFooter: { prev: '上一页', next: '下一页' },
        langMenuLabel: '切换语言',
        returnToTopLabel: '回到顶部',
        sidebarMenuLabel: '菜单',
        darkModeSwitchLabel: '外观',
        lightModeSwitchTitle: '切换到浅色模式',
        darkModeSwitchTitle: '切换到深色模式',
        footer: {
          message: 'MIT License',
          copyright: '社区项目，与 Sentry 官方无隶属关系',
        },
      },
    },
    en: {
      label: 'English',
      lang: 'en-US',
      link: '/en/',
      description: 'Community Sentry SDK for Taro React WeChat mini programs',
      themeConfig: {
        nav: [
          { text: 'Getting started', link: '/en/guide/getting-started' },
          { text: 'Core concepts', link: '/en/guide/concepts' },
          {
            text: 'Guides',
            link: '/en/guide/replay',
            activeMatch: '^/en/guide/(?!getting-started|concepts)',
          },
          { text: 'CHANGELOG', link: `${repo}/blob/main/CHANGELOG.md` },
        ],
        sidebar: { '/en/guide/': enSidebar() },
        editLink: {
          pattern: `${repo}/edit/main/website/:path`,
          text: 'Edit this page on GitHub',
        },
        outline: { level: [2, 3] },
        footer: {
          message: 'MIT License',
          copyright: 'Community project, not affiliated with Sentry',
        },
      },
    },
  },
});
