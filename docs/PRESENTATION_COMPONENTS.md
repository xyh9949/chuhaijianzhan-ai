# 展示组件与富文本

S05开发批次，发布协议9，兼容历史1–8。现有Text保持纯文本；选中静态Text可明确转换为RichText，已有动态绑定需先处理，避免转换时丢失绑定含义。

RichText保存Tiptap JSON：段落、二/三级标题、粗体、斜体、项目/编号列表、安全链接、换行。最多2000节点、12层、60000字符。保存与发布验证层级、属性和链接，公开端直接创建React元素，不接受HTML或任意扩展。当前仅静态富文本，不声明支持富文本字段动态绑定。

Tiptap React/PM/StarterKit直接依赖固定3.33.0，MIT许可证随依赖保留；Puck原有同源依赖继续使用其锁文件约束。Ant没有富文本引擎，因此使用Tiptap并以Ant提供工具栏、对话框。编辑引擎只由后台编辑配置引用，公开渲染器不引用Tiptap。升级后回归选区、格式、链接、撤销、粘贴、冷刷新和结构校验。实现参照[React/Next集成](https://tiptap.dev/docs/editor/getting-started/install/nextjs)、[JSON持久化](https://tiptap.dev/docs/editor/core-concepts/persistence)、[链接白名单接口](https://tiptap.dev/docs/editor/extensions/marks/link)。

Icon使用内置10个Ant图标，不接任意SVG；Divider使用Ant。Gallery最多20张、Carousel最多10张，支持排序、替代文字、说明、裁切比例/方式及三端外观。Accordion最多50项、Tabs最多8项，标题和正文可编辑；当前面板正文为纯文本。新组件可进入共享区块/循环卡片，实例控件名称和灯箱ID按节点命名空间隔离。

Ant Tabs/图片预览等交互依赖水合，而私有预览仅序列化SSR HTML，因此FAQ使用details，标签面板使用原生radio组，灯箱使用原生popover配Ant按钮，轮播使用滚动吸附及真实锚点。无需自制交互脚本，键盘和无JS下仍可操作；灯箱适用于支持Popover API的现代浏览器。不自动轮播，减少动态效果偏好会关闭平滑滚动。

Video接受受控本地MP4/WebM或HTTPS YouTube/Vimeo视频标识，外部地址规范化到固定嵌入域名，去掉附加参数，不接受iframe源码。默认不自动播放。本地视频上限40MB，检查容器签名但不转码，具体编码须由目标浏览器支持；图片仍保持8MB和真实解码/重编码。视频响应支持单一字节Range及416越界拒绝。视频/封面/图库会检查素材类型、进入版本和删除保护。测试MP4为FFmpeg生成的一秒纯色片段，不是客户工厂资料。

私有素材由已鉴权父层按实际流式字节读取，再交给无同源权限的沙箱；单页合计64MB、单文件40MB。不依赖Content-Length，因为Next流式响应可能省略该头部，不向沙箱传认证。升级Next后回归没有Content-Length的素材、预览视频和Range。
