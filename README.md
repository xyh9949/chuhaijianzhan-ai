# 出海建站 AI

<img src="public/images/brand/chuhaijianzhan-ai.png" width="380" alt="">

[English](README.en.md)

出海建站 AI 帮助中国外贸团队自己搭建独立站。接入你自己的 AI，用中文介绍公司、产品和建站需求，就能生成一套可预览、可拖拽修改的网站。后台可以自己部署，网站支持多语言产品目录和在线询价。

**0.42.0 Beta** 新增产品型号对比表、项目时间线、图片前后对比和六种现成业务区块。

## 快速开始

使用 **Node.js 22.15 或同一主版本中更新的 Node.js 22**。在仓库根目录执行：

```sh
npm ci
npm run setup
npm run build
npm start
```

1. 按初始化提示填写首位管理员的邮箱和至少 12 个字符的密码。程序会为该实例生成密钥并初始化 SQLite。
2. 打开[管理后台](http://127.0.0.1:3200/admin)，在「站点设置 → AI服务」接入自己的 AI。进入「模板与区块 → AI快速建站」，用中文说明要做什么网站，再预览建站方案。
3. 将预览结果保存为草稿，按需要拖拽修改页面。也可以在「模板与区块 → 整站案例」预览并导入虚构示例，直接体验页面编辑。
4. 在「发布管理」检查并发布选中的改动。[公开网站](http://127.0.0.1:3200/)会显示已发布版本。

## 主要功能

- 拖拽编辑页面，分别调整桌面、平板和手机布局。集中管理产品、分类和复用区块。
- 在独立草稿内修改，预览确认后发布所选范围，支持切换历史公开版本。
- 买家可以一次提交多款产品、数量和要求。运营人员可按 SKU 预览并确认 Excel 更新。
- 用 AI 搭建整站、调整指定页面和写产品介绍。邮件和其他外部服务可按实例配置。

[整站案例](docs/SHOWCASE_THEMES.md) · [业务区块](docs/BUSINESS_BLOCKS.md) · [网站表单](docs/WEBSITE_FORMS.md) · [AI 配置](docs/AI_SETTINGS.md)

## 部署与参与

每个部署实例服务一个独立网站，使用一个 Node 写进程和本地持久 SQLite 存储。HTTPS、Linux 容器、备份和恢复参见[部署说明](DEPLOYMENT.md)和[运维手册](docs/OPERATIONS.md)。

[贡献指南](CONTRIBUTING.md) · [报告安全问题](SECURITY.md) · [MIT 许可证](LICENSE) · [第三方许可说明](THIRD_PARTY_NOTICES.md)
