# 可导入模板包

在后台“模板与分发→整站包”选择JSON，先检查方案再明确导入草稿；导入不会自动发布。新客户空白实例可选fresh；已有内容用merge并核对目录、产品型号前缀、语言合并和目标品牌保持规则。

- manufacturing.json：Atlas Works制造企业，海军蓝/冷白、产品目录/规格/询盘。
- services.json：North Advisory专业服务，暖白/衬线/酒红、服务模型与自由卡片。
- portfolio.json：Field Studio个人作品集，深色/荧光绿、大字与项目详情。
- developer-demo.json：带英德互译、关系/条件布局、本地规格表、PDF和高级定位的**开发/验收样板**，包含明确的合成验收名称，不是客户成品网站。

全部公司/产品/案例内容均为演示设定；不代表真实认证、参数、业绩或交期。交付客户前替换为客户确认且有权使用的资料。软件/素材授权记录见各包manifest及项目THIRD_PARTY_NOTICES.md；没有附带账号、询盘、SMTP或私密密钥。

当前包依赖协议15；developer-demo还需要studio/SpecificationTable本地实现（数据v1/v2兼容，导入时归一化为v2）。缺失组件不能自动安装，也不能用旧程序强行降低版本导入。安装、升级与回退见../OPERATIONS.md和../DEVELOPER_EXTENSIONS.md。
