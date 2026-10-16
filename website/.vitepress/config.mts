import { defineConfig } from 'vitepress';

const repo = 'https://github.com/xumoses/sentry-taro';

export default defineConfig({
  lang: 'zh-CN',
  title: 'Sentry for Taro',
  description: '面向 Taro React 微信小程序的社区 Sentry SDK',
  cleanUrls: true,
  lastUpdated: false,
  themeConfig: {
    nav: [
      { text: '快速开始', link: '/guide/getting-started' },
      { text: '使用文档', link: `${repo}/blob/main/docs/README.md` },
      { text: 'CHANGELOG', link: `${repo}/blob/main/CHANGELOG.md` },
    ],
    socialLinks: [{ icon: 'github', link: repo }],
    outline: { label: '本页目录' },
    docFooter: { prev: '上一页', next: '下一页' },
    footer: {
      message: 'MIT License',
      copyright: '社区项目，与 Sentry 官方无隶属关系',
    },
  },
});
