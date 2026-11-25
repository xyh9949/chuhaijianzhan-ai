import type { ComponentData, Data } from '@puckeditor/core';
import protocol from '../protocol.json';
import type { SiteSnapshot } from '../../server/types';
import type { ContentEntry, ContentModel, FieldBinding, PageItem, PageTemplate, SharedBlock, SiteTheme } from '../types';
import type { DesignValues, ResponsiveDesign } from '../responsive-style';

/**
 * HELIOFORM 建筑级智能照明与光控 OEM 整站案例。
 * 采用极黑曜石暗夜 × 建筑暖石白 × 熔金琥珀配色，结合 12 列不对称瑞士网格与三字体排版，
 * 完全基于系统原生组件与 0.42.0 外贸展示控件构建，无任何自定义渲染器或外部依赖。
 */
export function createOemSolutionsStarter(): SiteSnapshot {
  const c = {
    obsidian: '#090b0f',
    surface: '#12161f',
    surfaceHover: '#191f2c',
    glass: '#090b0fd9',
    glassCard: '#12161fe6',
    stone: '#f6f5f0',
    white: '#ffffff',
    ink: '#11141a',
    inkMuted: '#58606d',
    cream: '#f3f1eb',
    mutedDark: '#9ca4b3',
    lineDark: '#232936',
    lineLight: '#dfddd6',
    gold: '#e5a93c',
    goldHover: '#f0bc58',
    goldSoft: '#2b2416',
  };

  const brand = 'HELIOFORM';
  const heroImg = '/images/helioform-hero.jpg';
  const opticsImg = '/images/helioform-optics.jpg';
  const beforeImg = '/images/helioform-before.jpg';
  const afterImg = '/images/helioform-after.jpg';
  const date = '2026-11-25T00:00:00.000Z';
  let sequence = 0;

  const node = (type: string, props: Record<string, unknown>): ComponentData => ({
    type,
    props: { id: `hf-${type}-${++sequence}`, ...props },
  });
  const data = (title: string, content: ComponentData[], chrome = true): Data => ({
    root: { props: { title, brand, showChrome: chrome ? 'yes' : 'no' } },
    content,
  } as Data);

  // 三字体排版原语：Georgia 衬线展示标题 / Mono 等宽工程标尺 / Inter 极简正文
  const display = (
    value: string,
    size = 56,
    options: { color?: string; level?: string; maxWidth?: number; tabletSize?: number; mobileSize?: number; align?: 'left' | 'center' } = {},
  ) => {
    const mobile = options.mobileSize ?? (size >= 60 ? 36 : Math.min(size, 30));
    const tablet = options.tabletSize ?? (size >= 60 ? 48 : Math.min(size, 38));
    return node('Heading', {
      text: value,
      size,
      mobileSize: mobile,
      color: options.color || c.cream,
      align: options.align || 'left',
      style: 'serif',
      spacing: 0,
      level: options.level || 'h2',
      design: {
        desktop: {
          fontFamily: 'serif',
          fontWeight: 400,
          lineHeight: 1.06,
          letterSpacing: size >= 52 ? -1.4 : -0.6,
          maxWidth: options.maxWidth || 880,
        },
        tablet: { fontSize: tablet, letterSpacing: -0.8 },
        mobile: { fontSize: mobile, letterSpacing: -0.4, lineHeight: 1.12 },
      },
    });
  };

  const subhead = (value: string, size = 24, color = c.cream, level: 'h2' | 'h3' = 'h3') => node('Heading', {
    text: value,
    size,
    mobileSize: Math.min(size, 21),
    color,
    align: 'left',
    style: 'sans',
    spacing: 0,
    level,
    design: {
      desktop: { fontFamily: 'sans', fontWeight: 500, lineHeight: 1.24, letterSpacing: -0.3 },
      mobile: { fontSize: Math.min(size, 21) },
    },
  });

  const body = (value: string, color = c.mutedDark, size = 16, maxWidth = 680) => node('Text', {
    text: value,
    color,
    size,
    align: 'left',
    maxWidth,
    design: {
      desktop: { fontFamily: 'sans', lineHeight: 1.72 },
      mobile: { fontSize: Math.min(size, 15), lineHeight: 1.68 },
    },
  });

  const mono = (value: string, color = c.gold, size = 11) => node('Text', {
    text: value,
    color,
    size,
    align: 'left',
    maxWidth: 900,
    design: {
      desktop: { fontFamily: 'mono', fontSize: size, fontWeight: 500, letterSpacing: 1.8, lineHeight: 1.5 },
      mobile: { fontSize: Math.max(10, size - 1), letterSpacing: 1.2 },
    },
  });

  const button = (
    value: string,
    href: string,
    variant: 'gold' | 'outlineDark' | 'obsidian' | 'outlineLight' = 'gold',
  ) => {
    const styles = {
      gold: { bg: c.gold, fg: c.obsidian, bd: c.gold, hBg: c.goldHover, hBd: c.goldHover },
      outlineDark: { bg: 'transparent', fg: c.cream, bd: '#3a4356', hBg: c.surfaceHover, hBd: c.gold },
      obsidian: { bg: c.obsidian, fg: c.cream, bd: c.obsidian, hBg: '#1e2430', hBd: '#1e2430' },
      outlineLight: { bg: 'transparent', fg: c.ink, bd: '#c5c1b6', hBg: '#ebe9e1', hBd: c.ink },
    }[variant];
    return node('ActionButton', {
      text: value,
      href,
      kind: variant === 'gold' || variant === 'obsidian' ? 'theme' : 'outline',
      align: 'left',
      design: {
        desktop: {
          minHeight: 46,
          paddingTop: 12,
          paddingBottom: 12,
          paddingLeft: 24,
          paddingRight: 24,
          borderRadius: 2,
          fontSize: 13,
          fontWeight: 600,
          letterSpacing: 0.4,
          color: styles.fg,
          backgroundColor: styles.bg,
          borderWidth: 1,
          borderColor: styles.bd,
        },
        mobile: { minHeight: 44, paddingLeft: 18, paddingRight: 18 },
      },
      stateStyles: {
        hover: { desktop: { backgroundColor: styles.hBg, borderColor: styles.hBd } },
      },
    });
  };

  // 容器与 12 列瑞士建筑网格原语：自动在平板与手机断点重置 columnSpan，杜绝隐式网格轨道撑破自适应布局
  const box = (
    content: ComponentData[],
    options: { columns?: number; gap?: number; background?: string; image?: string; padding?: number; inset?: number; minHeight?: number; design?: ResponsiveDesign; nodeLabel?: string } = {},
  ) => {
    const { columns = 1, gap = 24, background = 'transparent', image = '', padding = 0, inset = 0, minHeight = 0, design = {}, nodeLabel } = options;
    const hasDesktopSpan = typeof design.desktop?.columnSpan === 'number' && design.desktop.columnSpan > 1;
    const tabletCols = columns > 4 ? 1 : columns === 4 ? 2 : columns === 3 ? 2 : columns === 2 ? 1 : 1;
    return node('Container', {
      content,
      layout: columns > 1 ? 'grid' : 'column',
      // 顶层 columns 保持在 1–4 校验范围内；真正的 12 列瑞士不对称网格由 design.desktop.columns 承载。
      columns: Math.min(columns, 4),
      mobileColumns: 1,
      gap,
      padding,
      inset,
      background,
      image,
      minHeight,
      align: 'start',
      ...(nodeLabel ? { nodeLabel } : {}),
      design: {
        desktop: { ...(columns > 1 ? { columns } : {}), alignItems: 'start', ...design.desktop },
        tablet: {
          ...(columns > 1 ? { columns: tabletCols } : {}),
          ...(hasDesktopSpan ? { columnSpan: 1 } : {}),
          gap: Math.min(gap, 24),
          ...design.tablet,
        },
        mobile: {
          columns: 1,
          ...(hasDesktopSpan ? { columnSpan: 1 } : {}),
          gap: Math.min(gap, 18),
          ...design.mobile,
        },
      },
    });
  };

  const band = (
    content: ComponentData[],
    options: { background?: string; padding?: number; columns?: number; gap?: number; image?: string; minHeight?: number; design?: DesignValues; tablet?: DesignValues; mobile?: DesignValues; nodeLabel?: string } = {},
  ) => {
    const bg = options.background || c.obsidian;
    // 浅色区块显式声明深墨继承色，避免 ComparisonTable/ProjectTimeline/Tabs/Accordion/Form 继承暗夜主题浅色文字。
    const inheritedColor = bg === c.stone || bg === c.white ? c.ink : bg === c.gold ? c.obsidian : c.cream;
    return box(content, {
      background: bg,
      image: options.image || '',
      minHeight: options.minHeight || 0,
      columns: options.columns || 1,
      gap: options.gap || 32,
      padding: options.padding ?? 88,
      inset: 48,
      nodeLabel: options.nodeLabel,
      design: {
        desktop: { maxWidth: 1480, marginLeft: 'auto', marginRight: 'auto', color: inheritedColor, ...options.design },
        tablet: { paddingLeft: 28, paddingRight: 28, paddingTop: 64, paddingBottom: 64, ...options.tablet },
        mobile: { paddingLeft: 20, paddingRight: 20, paddingTop: 44, paddingBottom: 44, ...options.mobile },
      },
    });
  };

  const photo = (src: string, alt: string, height = 440, position = 'center', radius = 2) => node('Image', {
    src,
    alt,
    height,
    fit: 'cover',
    radius,
    design: {
      desktop: { width: '100%', height, objectPosition: position, borderRadius: radius },
      tablet: { height: Math.min(height, 360) },
      mobile: { height: Math.min(height, 260), objectPosition: position },
    },
  });

  const hairline = (dark = true) => node('Divider', { color: dark ? c.lineDark : c.lineLight, thickness: 1, spacing: 0 });
  const page = (id: string, title: string, slug: string, modelId?: string): PageItem => ({
    id,
    title,
    slug,
    type: modelId ? '内容详情' : slug === '/products/:slug' ? '产品详情' : '普通页面',
    status: 'published',
    updated: date,
    ...(modelId ? { contentModelId: modelId } : {}),
    seoTitle: `${title} — HELIOFORM Architectural Lighting OEM`,
    seoDescription: 'HELIOFORM is a fictional architectural lighting and modular optical hardware OEM demonstration website.',
  });

  // 产品扩展模型 & 建筑光影案例模型
  const productModel: ContentModel = {
    id: 'hf-product-model',
    name: '光学与结构定制参数',
    target: 'product',
    description: '建筑照明 OEM 选型扩展参数，支持在产品管理中自由增删字段。',
    updated: date,
    fields: [
      { id: 'hf-field-series', key: 'series', label: '光学系列', type: 'text', required: false },
      { id: 'hf-field-optics', key: 'optics', label: '配光与防眩等级', type: 'text', required: false },
      { id: 'hf-field-control', key: 'control', label: '调光控制协议', type: 'text', required: false },
      { id: 'hf-field-custom', key: 'custom_scope', label: 'OEM 定制选项', type: 'textarea', required: false },
    ],
  };

  const caseModel: ContentModel = {
    id: 'hf-case-model',
    name: '建筑光影定制案例',
    target: 'content',
    description: '虚构的建筑照明 OEM/ODM 空间改造与定制交付研究，用于演示动态案例卡片与详情模板。',
    updated: date,
    fields: [
      { id: 'hf-case-sector', key: 'sector', label: '空间类型', type: 'text', required: false },
      { id: 'hf-case-summary', key: 'summary', label: '项目概述', type: 'textarea', required: false },
      { id: 'hf-case-image', key: 'image', label: '空间实景图', type: 'image', required: false },
      { id: 'hf-case-brief', key: 'brief', label: '照明挑战', type: 'textarea', required: false },
      { id: 'hf-case-solution', key: 'solution', label: '光学定制方案', type: 'textarea', required: false },
      { id: 'hf-case-handover', key: 'handover', label: '交付与质检资料', type: 'textarea', required: false },
    ],
  };

  const productBinding = (field: string): FieldBinding => ({ source: 'product', mode: 'current', modelId: productModel.id, field });
  const caseBinding = (field: string): FieldBinding => ({ source: 'entry', mode: 'current', modelId: caseModel.id, field });

  const boundMono = (binding: FieldBinding, fallback: string, color = c.gold) => node('Text', {
    text: fallback, size: 11, color, align: 'left', maxWidth: 800, bindings: { text: binding },
    design: { desktop: { fontFamily: 'mono', letterSpacing: 1.5, fontWeight: 500 }, mobile: { fontSize: 10 } },
  });
  const boundText = (binding: FieldBinding, fallback: string, color = c.mutedDark, size = 15) => node('Text', {
    text: fallback, size, color, align: 'left', maxWidth: 820, bindings: { text: binding },
    design: { desktop: { fontFamily: 'sans', lineHeight: 1.72 }, mobile: { fontSize: Math.min(size, 15) } },
  });
  const boundHeading = (binding: FieldBinding, fallback: string, size = 28, color = c.ink, level = 'h3') => node('Heading', {
    text: fallback, size, mobileSize: Math.min(size, 24), color, align: 'left', style: 'serif', level, bindings: { text: binding },
    design: { desktop: { fontFamily: 'serif', fontWeight: 400, lineHeight: 1.15 }, mobile: { fontSize: Math.min(size, 24) } },
  });
  const boundImage = (binding: FieldBinding, altBinding: FieldBinding, height = 260) => node('Image', {
    src: opticsImg, alt: 'HELIOFORM modular optical fixture concept', height, fit: 'cover', radius: 2,
    bindings: { src: binding, alt: altBinding },
    design: { desktop: { width: '100%', height }, mobile: { height: Math.min(height, 240) } },
  });
  // 文案不自带箭头，避免与组件内置箭头图标重复
  const cardLink = (binding: FieldBinding, title: string, color = c.ink) => node('ActionButton', {
    text: title, href: '', kind: 'outline', align: 'left', bindings: { href: binding },
    design: {
      desktop: { borderWidth: 0, borderRadius: 0, paddingLeft: 0, paddingRight: 0, paddingTop: 4, paddingBottom: 4, color, fontSize: 13, fontWeight: 600, letterSpacing: 0.3 },
      mobile: { fontSize: 13 },
    },
  });

  // 6 款虚构建筑照明与光控 OEM 产品
  const productSeeds = [
    {
      slug: 'hf-s10-micro-baffle', sku: 'HF-S10-MB', name: 'S10 Micro-Baffle Linear',
      category: 'Architectural Linear', termId: 'hf-cat-linear', series: 'S10 Architectural',
      material: 'CNC 6063 Black Anodised Aluminium · concept', image: opticsImg, gallery: [opticsImg, heroImg],
      description: 'An ultra-narrow recessed linear grazing module engineered for dark ceilings, travertine walls and gallery corridors. Deep optical micro-baffles conceal the source completely.',
      optics: '15° / 30° / Wall-wash · UGR < 13 (illustrative)',
      control: 'DALI-2 DT8 · 0–10V · Phase-cut option',
      custom: 'Cut-to-length extrusion runs, 2200K–4000K CRI 97+ binning, matte black / dark bronze / raw brass baffle finish.',
      specs: [
        { label: 'Series', value: 'S10 Architectural' },
        { label: 'Beam Options', value: '15° / 30° / Asymmetric Wash' },
        { label: 'Colour Quality', value: 'CRI 97+ · R9 > 90 (concept)' },
        { label: 'Control Bus', value: 'DALI-2 / 0–10V / Casambi' },
      ],
    },
    {
      slug: 'hf-s10-trimless-slot', sku: 'HF-S10-TS', name: 'S10 Trimless Wall-Grazer',
      category: 'Architectural Linear', termId: 'hf-cat-linear', series: 'S10 Architectural',
      material: 'Extruded Aluminium + Brass Heatsink · concept', image: heroImg, gallery: [heroImg, opticsImg],
      description: 'A plaster-in trimless linear slot that turns concrete and stone surfaces into sculptural planes of warm grazing light without visible ceiling flanges.',
      optics: 'Asymmetric 12°×45° grazing lens (illustrative)',
      control: 'DALI-2 · Tunable 2400K–3500K',
      custom: 'Plaster-in flange width, continuous corner miter kits, remote driver box layout and project room coding.',
      specs: [
        { label: 'Series', value: 'S10 Architectural' },
        { label: 'Mounting', value: 'Trimless plaster-in / recessed' },
        { label: 'Finish', value: 'Deep obsidian anodised' },
        { label: 'Ingress', value: 'IP40 indoor / IP65 wet option' },
      ],
    },
    {
      slug: 'hf-m24-accent-spot', sku: 'HF-M24-SP', name: 'M24 Museum Gimbal Spotlight',
      category: 'Precision Optics', termId: 'hf-cat-optics', series: 'M24 Gallery',
      material: 'Die-Cast & CNC Milled Aluminium · concept', image: opticsImg, gallery: [opticsImg, afterImg],
      description: 'A dual-axis gimbal accent luminaire with interchangeable magnetic honeycomb louvres and snoots for hospitality lobbies, art walls and retail showcases.',
      optics: '8° pin-spot to 45° flood · magnetic lens swap',
      control: 'DALI-2 · Local rotary dim option',
      custom: 'Custom anodized baffle rings, private-label laser serial plate, pre-aimed tilt lock and anti-glare snoot kit.',
      specs: [
        { label: 'Series', value: 'M24 Gallery' },
        { label: 'Adjustability', value: '355° pan · 35° lockable tilt' },
        { label: 'Accessories', value: 'Honeycomb louvre & linear spread' },
        { label: 'Thermal Core', value: 'Passive forged fin heatsink' },
      ],
    },
    {
      slug: 'hf-m24-pendant-beam', sku: 'HF-M24-PB', name: 'M24 Suspended Bi-Directional Beam',
      category: 'Precision Optics', termId: 'hf-cat-optics', series: 'M24 Gallery',
      material: 'Brushed Brass & Matte Obsidian Profile · concept', image: afterImg, gallery: [afterImg, opticsImg],
      description: 'A suspended architectural luminaire pairing indirect ceiling wash with precision downward task optics for executive lounges and hotel reception zones.',
      optics: 'Direct dark-light baffle + 110° indirect uplight',
      control: 'Dual-channel DALI-2 (independent up/down)',
      custom: 'Suspension drop length, RAL powder coat or brushed brass sleeve, acoustic canopy integration.',
      specs: [
        { label: 'Series', value: 'M24 Gallery' },
        { label: 'Distribution', value: '60% direct / 40% indirect' },
        { label: 'Profile Width', value: '38 mm architectural slimline' },
        { label: 'Suspension', value: 'Coaxial micro-cable 2m / 4m' },
      ],
    },
    {
      slug: 'hf-x40-facade-grazer', sku: 'HF-X40-FG', name: 'X40 Exterior Facade Linear',
      category: 'Exterior & Control', termId: 'hf-cat-exterior', series: 'X40 Exterior',
      material: 'Marine-Grade 6063 + Tempered Glass · concept', image: heroImg, gallery: [heroImg, afterImg],
      description: 'A sealed architectural exterior grazer built for stone colonnades, courtyards and coastal hotel facades with anti-corrosion marine coating.',
      optics: '10° / 20° / 15°×50° elliptical facade optic',
      control: 'DMX512-RDM · DALI-2 outdoor driver',
      custom: 'Marine salt-spray primer, custom bracket arm offset, waterproof quick-connect daisy chain and glare visor.',
      specs: [
        { label: 'Series', value: 'X40 Exterior' },
        { label: 'Protection', value: 'IP66 / IK08 concept baseline' },
        { label: 'Housing', value: 'Marine-grade anodised + powder coat' },
        { label: 'Protocol', value: 'DMX512-RDM / DALI-2' },
      ],
    },
    {
      slug: 'hf-x40-dali-hub', sku: 'HF-X40-DH', name: 'X40 Modular DALI-2 Driver Hub',
      category: 'Exterior & Control', termId: 'hf-cat-exterior', series: 'X40 Exterior',
      material: 'Anodised DIN-Rail Control Enclosure · concept', image: opticsImg, gallery: [opticsImg, beforeImg],
      description: 'A centralized multi-channel constant-current driver and DALI-2 commissioning hub designed to simplify ceiling access and bulk OEM project wiring.',
      optics: 'Flicker-free < 0.1% deep dimming to 0.1%',
      control: '4-Channel DALI-2 DT8 + Scene Memory',
      custom: 'Pre-labelled terminal blocks, custom silkscreen wiring map, regional voltage range and OEM firmware profile.',
      specs: [
        { label: 'Series', value: 'X40 Exterior' },
        { label: 'Channels', value: '4 × independent constant current' },
        { label: 'Dimming Depth', value: '0.1% logarithmic smooth curve' },
        { label: 'Mounting', value: 'DIN-rail or remote plenum box' },
      ],
    },
  ];

  const products: SiteSnapshot['products'] = productSeeds.map((item, index) => ({
    id: `hf-product-${index + 1}`,
    slug: item.slug,
    name: item.name,
    sku: item.sku,
    category: item.category,
    status: 'published',
    image: item.image,
    images: item.gallery,
    description: item.description,
    material: item.material,
    specifications: item.specs,
    modelId: productModel.id,
    updated: date,
    sortOrder: index,
    termIds: [item.termId],
    customFields: {
      'hf-field-series': item.series,
      'hf-field-optics': item.optics,
      'hf-field-control': item.control,
      'hf-field-custom': item.custom,
    },
    seoTitle: `${item.name} (${item.sku}) — HELIOFORM`,
    seoDescription: `${item.name}. Fictional architectural lighting OEM concept from the HELIOFORM catalogue.`,
  }));

  // 3 篇建筑光影 OEM 定制案例
  const cases: ContentEntry[] = [
    {
      id: 'hf-case-1',
      modelId: caseModel.id,
      slug: 'monolith-hotel-atrium-retrofit',
      title: 'Replacing flat fluorescent ceilings with 2700K architectural contrast',
      status: 'published',
      updated: date,
      sortOrder: 0,
      customFields: {
        'hf-case-sector': 'HOSPITALITY RETROFIT · CONCEPT',
        'hf-case-image': afterImg,
        'hf-case-summary': 'A fictional lobby retrofit study demonstrating how recessed dark-baffle spotlights and hidden grazing slots elevate stone and oak architecture.',
        'hf-case-brief': 'The original atrium suffered from flat cool-white overhead illumination that washed out the slatted timber reception wall and created glare on honed stone floors.',
        'hf-case-solution': 'Combine S10 trimless linear wall-grazers along the timber backdrop with M24 narrow-beam gimbal accents locked to 2700K, commissioned via a single X40 DALI-2 scene hub.',
        'hf-case-handover': 'Illustrative OEM handover pack: IES photometric files, golden-sample finish board, room-coded carton labels and DALI commissioning map. Fictional demonstration only.',
      },
    },
    {
      id: 'hf-case-2',
      modelId: caseModel.id,
      slug: 'brutalist-gallery-corridor',
      title: 'Razor-sharp linear grazing for a travertine and concrete gallery',
      status: 'published',
      updated: date,
      sortOrder: 1,
      customFields: {
        'hf-case-sector': 'CULTURAL & GALLERY · CONCEPT',
        'hf-case-image': heroImg,
        'hf-case-summary': 'Aligning continuous custom-length S10 linear extrusions with architectural reveals and zero visible glare along a 42-metre dusk corridor.',
        'hf-case-brief': 'The architect required uninterrupted vertical and horizontal light lines recessed into dark concrete without visible diffuser hotspots or colour-temperature drift across batches.',
        'hf-case-solution': 'Specify tight 2-step MacAdam binning at 3000K, custom mitered corner extrusions in matte obsidian anodising, and remote X40 constant-current driver boxes.',
        'hf-case-handover': 'Illustrative OEM handover pack: extruded cut-list drawing, spectrometer binning report template, pre-shipment burn-in log and export crate schedule. Fictional demonstration only.',
      },
    },
    {
      id: 'hf-case-3',
      modelId: caseModel.id,
      slug: 'private-label-optical-system',
      title: 'Building a unified private-label optical platform for European distributors',
      status: 'published',
      updated: date,
      sortOrder: 2,
      customFields: {
        'hf-case-sector': 'OEM / ODM PLATFORM · CONCEPT',
        'hf-case-image': opticsImg,
        'hf-case-summary': 'How a lighting brand consolidates linear, gimbal and control hardware around one shared heatsink and baffle architecture to cut tooling overhead.',
        'hf-case-brief': 'Managing three separate factories caused mismatched matte-black finishes, inconsistent dimming curves and fragmented export packaging across regional stockists.',
        'hf-case-solution': 'Standardise on shared CNC anodised housings and brushed brass thermal cores with magnetic optical lenses, laser-etched distributor branding and unified barcode cartons.',
        'hf-case-handover': 'Illustrative OEM handover pack: master finish swatch, laser-mark artwork proof, batch QC checklist and container palletisation plan. Fictional demonstration only.',
      },
    },
  ];

  // 开启 multiProduct: true 的多产品询价单
  const form = {
    id: 'hf-rfq',
    name: '多产品建筑照明 OEM 询价单',
    enabled: true,
    multiProduct: true,
    submitLabel: 'Submit Multi-SKU RFQ',
    successMessage: 'Thank you. Your architectural lighting OEM enquiry has been recorded.',
    fields: [
      { id: 'hf-rfq-name', label: 'Your name', type: 'text' as const, mapTo: 'name' as const, required: true, maxLength: 150, placeholder: 'Full name' },
      { id: 'hf-rfq-email', label: 'Work email', type: 'email' as const, mapTo: 'email' as const, required: true, maxLength: 254, placeholder: 'spec@studio.com' },
      { id: 'hf-rfq-company', label: 'Company / Studio', type: 'text' as const, mapTo: 'company' as const, required: false, maxLength: 150, placeholder: 'Architecture firm, OEM brand or distributor' },
      { id: 'hf-rfq-country', label: 'Destination region', type: 'country' as const, mapTo: 'country' as const, required: false, maxLength: 100 },
      { id: 'hf-rfq-message', label: 'Optical, finish & project brief', type: 'textarea' as const, mapTo: 'message' as const, required: true, maxLength: 4000, placeholder: 'Share CCT/CRI targets, dimming protocol, custom lengths, finish sample needs or project timeline.' },
    ],
  };

  // 核心 0.42.0 展示控件：极简短行表头彻底杜绝窄屏断词，显式深墨色保证浅色背景高对比度
  const comparisonTable = (title = 'HELIOFORM Series Comparison') => node('ComparisonTable', {
    title,
    modelColumns: ['S10 Linear', 'M24 Gallery', 'X40 Exterior'],
    rows: [
      { label: 'Use', values: ['Wall grazing & trimless coves', 'Museums, lobbies & accent beams', 'Facades, colonnades & driver hubs'] },
      { label: 'Beam', values: ['15° / 30° / Asymmetric · UGR < 13', '8°–45° magnetic swap + louvre', '10°–50° sealed facade optics'] },
      { label: 'Body', values: ['CNC 6063 obsidian anodised', 'Milled alloy + brushed brass core', 'Marine-grade IP66 / IK08 body'] },
      { label: 'Bus', values: ['DALI-2 DT8 / 0–10V / Phase', 'DALI-2 / Local dim / Dual-channel', 'DMX512-RDM / 4-ch DALI-2 Hub'] },
      { label: 'OEM', values: ['Cut-to-length runs & miter kits', 'Custom baffle finish & laser logo', 'Salt-spray coat & room-coded crates'] },
    ],
    design: { desktop: { color: c.ink, backgroundColor: c.white } },
  });

  const lightComparison = (mode: 'toggle' | 'split' = 'toggle') => node('ImageComparison', {
    title: 'Before & After — Architectural Lobby Lighting Retrofit',
    mode,
    before: {
      src: beforeImg,
      label: 'Before · Flat 6500K Overhead',
      alt: 'Modern stone and timber hotel lobby before lighting upgrade under flat cool-white overhead fluorescent panels',
    },
    after: {
      src: afterImg,
      label: 'After · 2700K HELIOFORM Optics',
      alt: 'The same stone and timber hotel lobby transformed with warm 2700K grazing coves and dramatic dark-baffle spotlights',
    },
  });

  const oemTimeline = () => node('ProjectTimeline', {
    title: 'Five precision stages from photometric brief to shipment',
    items: [
      { label: '01 · Photometric brief', title: 'Align beam angles, CCT binning and control bus', description: 'Confirm target surfaces, glare limits, dimming protocol and regional voltage before quoting.' },
      { label: '02 · Mechanical DFM', title: 'Review extrusion lengths, cutouts and finish swatches', description: 'Validate ceiling clearances, thermal paths, anodised colour tones and private-label laser marks.' },
      { label: '03 · Golden sample', title: 'Sign off physical optical sample and burn-in check', description: 'Approve light distribution, baffle glare cut-off and dimming smoothness against a physical sample.' },
      { label: '04 · Batch QC & ageing', title: 'Run spectrometer binning and 100% ageing inspection', description: 'Verify colour consistency, driver response, wiring labels and carton barcode accuracy prior to sealing.' },
      { label: '05 · Export handover', title: 'Deliver room-coded cartons, packing list and IES pack', description: 'Ship moisture-protected export crates with gross-weight manifests and pre-loading photographs.' },
    ],
  });

  const qualityTimeline = () => node('ProjectTimeline', {
    title: 'Optical quality & export dispatch gates',
    items: [
      { label: 'Gate 01 · Incoming', title: 'Verify LED reel binning and alloy surface grade', description: 'Check MacAdam ellipse tolerance, heatsink flatness and raw extrusion finish before CNC machining.' },
      { label: 'Gate 02 · Photometry', title: 'Measure CRI, beam cut-off and thermal equilibrium', description: 'Test optical alignment, glare baffle fitment and junction temperature stability on sample runs.' },
      { label: 'Gate 03 · Ageing', title: 'Complete power-cycle burn-in and DALI addressing check', description: 'Confirm flicker-free low-end dimming and control response across every assembled module.' },
      { label: 'Gate 04 · Packing', title: 'Audit room-coded labels, foam cradles and pallet wrap', description: 'Verify SKU marks, moisture barriers, export crate counts and container loading photos.' },
    ],
  });

  const customTabs = () => node('Tabs', {
    panelMode: 'free',
    design: { desktop: { color: c.ink, backgroundColor: c.white } },
    items: [
      {
        id: 'hf-tab-optics',
        title: 'Optics & CRI',
        content: [box([
          photo(opticsImg, 'Precision CNC matte black luminaire housings and optical micro-baffles', 280),
          box([
            subhead('Tailor beam geometry and spectral mood.', 26, c.ink, 'h3'),
            body('Choose from 8° museum pin-spots to asymmetric wall-grazers, paired with 2200K–4000K high-CRI binning and magnetic anti-glare honeycomb accessories.', c.inkMuted, 15),
            box([mono('SPECIFY AT RFQ', c.ink), body('Beam angle · CCT & CRI target · UGR limit · honeycomb or linear spread accessory', c.inkMuted, 14)], { background: c.stone, padding: 18, inset: 18, gap: 6, design: { desktop: { borderWidth: 1, borderColor: c.lineLight } } }),
          ], { gap: 16 }),
        ], { columns: 2, gap: 32, design: { desktop: { alignItems: 'center' } } })],
      },
      {
        id: 'hf-tab-finish',
        title: 'Metals & RAL',
        content: [box([
          photo(heroImg, 'Dark concrete and brushed anodized aluminum gallery corridor lit by warm linear slots', 280),
          box([
            subhead('Architectural metals that disappear into shadow.', 26, c.ink, 'h3'),
            body('Specify deep obsidian bead-blast anodising, warm brushed brass baffles, dark bronze or custom RAL architectural powder coats with marine-grade outdoor primers.', c.inkMuted, 15),
            button('Browse optical hardware', '/catalog', 'obsidian'),
          ], { gap: 16 }),
        ], { columns: 2, gap: 32, design: { desktop: { alignItems: 'center' } } })],
      },
      {
        id: 'hf-tab-branding',
        title: 'DALI-2 & OEM',
        content: [box([
          photo(afterImg, 'Hotel lobby illuminated by commissioned architectural spotlights and linear coves', 280),
          box([
            subhead('Commissioning-ready drivers and OEM packaging.', 26, c.ink, 'h3'),
            body('Consolidate DALI-2 DT8, 0–10V or DMX512-RDM driver boxes with laser-etched brand marks, IES data packs and room-coded export cartons for seamless site handover.', c.inkMuted, 15),
            button('Inspect QC & export gates', '/quality-logistics', 'outlineLight'),
          ], { gap: 16 }),
        ], { columns: 2, gap: 32, design: { desktop: { alignItems: 'center' } } })],
      },
    ],
  });

  const faqItems = [
    ['How do I bundle multiple luminaires into one RFQ?', 'Open any product in the catalogue to add it to your multi-product inquiry list with quantities and CCT/finish notes, then review and submit all selected models together on the RFQ page.'],
    ['What technical details help speed up an OEM quote?', 'Share reference SKUs, target colour temperature (e.g. 2700K or 3000K), beam direction, dimming protocol (DALI-2, 0–10V or DMX), estimated quantities and destination country.'],
    ['Can finishes and optical accessories be sampled first?', 'Yes. In a real lighting OEM workflow, anodized finish swatches, golden optical samples and IES files should be reviewed and signed off before batch production begins.'],
    ['How are long linear extrusions packed for export?', 'Custom-length linear profiles and precision optics are typically packed in foam-cradled inner sleeves inside reinforced export crates with room-coded labels confirmed prior to dispatch.'],
    ['Is HELIOFORM a real lighting manufacturer?', 'No. HELIOFORM is a fictional architectural lighting demonstration brand created to showcase dark-luxury editorial layouts, before-and-after light comparisons, model matrices and multi-SKU RFQs.'],
  ];
  const faq = (count = faqItems.length, dark = false) => node('Accordion', {
    panelMode: 'free',
    firstOpen: true,
    items: faqItems.slice(0, count).map(([title, answer], index) => ({
      id: `hf-faq-${index + 1}`,
      title,
      content: [box([
        body(answer, dark ? c.mutedDark : c.inkMuted, 15, 900),
        ...(index === 0 ? [button('Open multi-SKU RFQ', '/contact', dark ? 'outlineDark' : 'outlineLight')] : []),
      ], { padding: 12, inset: 6, gap: 16 })],
    })),
    ...(dark ? { design: { desktop: { backgroundColor: c.surface, color: c.cream, borderColor: c.lineDark } } } : {}),
  });

  const inquiry = () => node('Form', {
    formId: form.id,
    wideFields: ['hf-rfq-message'],
    buttonAlign: 'left',
    design: { desktop: { columns: 2, gap: 20, maxWidth: 920 }, mobile: { columns: 1, gap: 16 } },
    fieldDesign: { desktop: { borderWidth: 1, borderColor: c.lineLight, borderRadius: 2, backgroundColor: c.white, paddingTop: 12, paddingBottom: 12 } },
    submitDesign: { desktop: { backgroundColor: c.obsidian, color: c.cream, borderColor: c.obsidian, borderRadius: 2, height: 48, fontWeight: 600 } },
  });

  // 熔金撞色终章 CTA：黑字金底，极强瑞士建筑杂志收尾感
  const goldCta = (title = 'Specify precision light for your next project.') => band([
    box([
      mono('MULTI-PRODUCT OEM RFQ · GLOBAL EXPORT', c.obsidian),
      display(title, 48, { color: c.obsidian, maxWidth: 680, tabletSize: 38, mobileSize: 32 }),
      body('Bundle linear grazers, museum gimbals and DALI-2 hubs into one structured technical brief.', '#2c2516', 16, 560),
    ], { gap: 16, design: { desktop: { columnSpan: 7 }, mobile: { columnSpan: 1 } } }),
    box([
      button('Start multi-SKU RFQ', '/contact', 'obsidian'),
      button('Explore OEM catalogue', '/catalog', 'outlineLight'),
    ], { gap: 12, design: { desktop: { columnSpan: 5, alignItems: 'end', justifyContent: 'center' }, mobile: { columnSpan: 1, alignItems: 'start' } } }),
  ], { columns: 12, background: c.gold, padding: 72, gap: 40, design: { alignItems: 'center' }, nodeLabel: '熔金多产品询价终章' });

  const breadcrumbBar = (dark = true) => band([
    node('Breadcrumb', {
      homeLabel: 'Home',
      design: {
        desktop: { color: dark ? c.mutedDark : c.inkMuted, fontSize: 12 },
        mobile: { fontSize: 12 },
      },
    }),
  ], {
    background: dark ? c.surface : c.stone,
    padding: 0,
    design: { paddingTop: 4, paddingBottom: 4, borderWidth: 1, borderColor: dark ? c.lineDark : c.lineLight },
    mobile: { paddingTop: 2, paddingBottom: 2 },
    nodeLabel: '页面面包屑导航',
  });

  const pageIntro = (eyebrow: string, title: string, copyText: string) => band([
    box([
      mono(eyebrow, c.gold),
      display(title, 62, { color: c.cream, level: 'h1', maxWidth: 960, tabletSize: 46, mobileSize: 34 }),
    ], { gap: 18, design: { desktop: { columnSpan: 8 }, mobile: { columnSpan: 1 } } }),
    box([
      body(copyText, c.mutedDark, 16, 460),
    ], { gap: 12, design: { desktop: { columnSpan: 4, paddingTop: 28 }, mobile: { columnSpan: 1, paddingTop: 0 } } }),
  ], { columns: 12, background: c.obsidian, padding: 80, gap: 40, design: { borderWidth: 1, borderColor: c.lineDark }, nodeLabel: '暗夜页头标题区' });

  const productLoop = (count = 6, controls = false) => node('ContentLoop', {
    source: 'product',
    modelId: productModel.id,
    itemBlockId: 'hf-product-card',
    title: '',
    count,
    columns: 3,
    mobileColumns: 1,
    gap: 28,
    padding: 0,
    emptyText: 'Architectural luminaire modules will appear here.',
    ...(controls ? { query: { controls: true, sort: 'builtin:sortOrder', direction: 'asc' } } : {}),
    design: { desktop: { paddingLeft: 0, paddingRight: 0 }, mobile: { paddingLeft: 0, paddingRight: 0 } },
  });

  const caseLoop = (count = 3) => node('ContentLoop', {
    source: 'entry',
    modelId: caseModel.id,
    itemBlockId: 'hf-case-card',
    title: '',
    count,
    columns: 3,
    mobileColumns: 1,
    gap: 28,
    padding: 0,
    emptyText: 'Architectural lighting studies will appear here.',
    design: { desktop: { paddingLeft: 0, paddingRight: 0 }, mobile: { paddingLeft: 0, paddingRight: 0 } },
  });

  // 首页与方案页共用的交互式光学/材质/控制标签台
  const interactiveConfigTabs = () => node('Tabs', {
    panelMode: 'free',
    design: { desktop: { color: c.ink, backgroundColor: c.white } },
    items: [
      {
        id: 'hf-home-tab-optics',
        title: '01 · Optics',
        content: [box([
          photo(opticsImg, 'Precision CNC matte black luminaire housings and optical micro-baffles', 300),
          box([
            mono('OPTICAL ENGINEERING', '#9a6b17'),
            subhead('8° pin-spots to asymmetric wall-grazers.', 26, c.ink, 'h3'),
            body('Interchangeable magnetic honeycomb louvres and deep dark-chrome baffles achieve UGR < 13 visual comfort with tight 2-step MacAdam colour consistency.', c.inkMuted, 15),
            box([mono('KEY OPTIONS', c.ink, 10), body('15° / 24° / 36° / Wall-wash · 2200K–4000K CRI 97+ · R9 > 90', c.inkMuted, 14)], { background: c.stone, padding: 16, inset: 16, gap: 4, design: { desktop: { borderWidth: 1, borderColor: c.lineLight } } }),
          ], { gap: 14 }),
        ], { columns: 2, gap: 32, design: { desktop: { alignItems: 'center' } } })],
      },
      {
        id: 'hf-home-tab-metals',
        title: '02 · Metals',
        content: [box([
          photo(heroImg, 'Dark concrete and brushed anodized aluminum gallery corridor lit by warm linear slots', 300),
          box([
            mono('SURFACE & THERMAL', '#9a6b17'),
            subhead('Bead-blasted obsidian and forged brass cores.', 26, c.ink, 'h3'),
            body('Specify matte obsidian anodising, brushed raw brass baffles, dark architectural bronze or custom RAL marine-grade coatings built for humid and coastal projects.', c.inkMuted, 15),
            button('Explore product finishes', '/catalog', 'obsidian'),
          ], { gap: 14 }),
        ], { columns: 2, gap: 32, design: { desktop: { alignItems: 'center' } } })],
      },
      {
        id: 'hf-home-tab-control',
        title: '03 · DALI-2',
        content: [box([
          photo(afterImg, 'Hotel lobby illuminated by commissioned architectural spotlights and linear coves', 300),
          box([
            mono('SMART CONTROL & EXPORT', '#9a6b17'),
            subhead('0.1% flicker-free dimming & room-coded crates.', 26, c.ink, 'h3'),
            body('Pre-addressed DALI-2 DT8, 0–10V and DMX512-RDM driver hubs ship with IES photometric bundles, laser-etched private labels and room-coded carton manifests.', c.inkMuted, 15),
            button('Start multi-SKU RFQ', '/contact', 'outlineLight'),
          ], { gap: 14 }),
        ], { columns: 2, gap: 32, design: { desktop: { alignItems: 'center' } } })],
      },
    ],
  });

  // 共享页眉（全尺寸单行弹性自适应吸顶导航栏：360px 手机到 1920px 宽屏始终保持单行水平对齐）、页脚与动态卡片
  const sharedBlocks: SharedBlock[] = [
    {
      id: 'hf-header',
      name: '全站页眉 · HELIOFORM 全尺寸自适应吸顶导航',
      updated: date,
      data: data('HELIOFORM Header', [band([
        box([
          node('Heading', {
            text: brand,
            size: 22,
            mobileSize: 18,
            color: c.cream,
            align: 'left',
            style: 'serif',
            level: 'h2',
            spacing: 0,
            design: {
              desktop: { fontFamily: 'serif', letterSpacing: 2.4, fontWeight: 400 },
              tablet: { fontSize: 19, letterSpacing: 1.8 },
              mobile: { fontSize: 18, letterSpacing: 1.6 },
            },
          }),
          node('Text', {
            text: 'ARCHITECTURAL OPTICS · OEM',
            color: c.gold,
            size: 10,
            align: 'left',
            maxWidth: 320,
            design: {
              desktop: { fontFamily: 'mono', fontSize: 10, fontWeight: 500, letterSpacing: 1.6, lineHeight: 1.4 },
              tablet: { display: 'none' },
              mobile: { display: 'none' },
            },
          }),
        ], { gap: 2 }),
        box([
          node('Navigation', {
            menuId: 'hf-menu',
            label: 'Main navigation',
            openLabel: 'Menu',
            design: {
              desktop: { color: c.cream, fontSize: 13 },
              tablet: { color: c.cream, fontSize: 13 },
              mobile: { color: c.cream, fontSize: 14 },
            },
          }),
          box([
            button('Multi-SKU RFQ', '/contact', 'gold'),
          ], {
            design: {
              desktop: { display: 'block' },
              tablet: { display: 'block' },
              mobile: { display: 'none' },
            },
          }),
        ], {
          gap: 20,
          design: {
            desktop: { display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'end', gap: 20 },
            tablet: { display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'end', gap: 12 },
            mobile: { display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'end', gap: 8 },
          },
        }),
      ], {
        background: c.glass,
        padding: 16,
        gap: 16,
        design: {
          display: 'flex',
          flexDirection: 'row',
          flexWrap: 'nowrap',
          justifyContent: 'space-between',
          alignItems: 'center',
          position: 'sticky',
          top: 0,
          zIndex: 18,
          borderWidth: 1,
          borderColor: c.lineDark,
        },
        tablet: {
          display: 'flex',
          flexDirection: 'row',
          flexWrap: 'nowrap',
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingTop: 14,
          paddingBottom: 14,
          paddingLeft: 24,
          paddingRight: 24,
        },
        mobile: {
          display: 'flex',
          flexDirection: 'row',
          flexWrap: 'nowrap',
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingTop: 12,
          paddingBottom: 12,
          paddingLeft: 16,
          paddingRight: 16,
        },
        nodeLabel: '全尺寸单行自适应吸顶导航栏',
      })], false),
    },
    {
      id: 'hf-footer',
      name: '全站页脚 · HELIOFORM',
      updated: date,
      data: data('HELIOFORM Footer', [band([
        box([
          display(brand, 34, { color: c.cream, mobileSize: 26 }),
          body('Precision architectural illumination, modular optical engineering and multi-SKU OEM workflows.', c.mutedDark, 15, 420),
          mono('FICTIONAL BRAND · CONCEPT DEMONSTRATION', c.gold, 10),
        ], { gap: 16, design: { desktop: { columnSpan: 5 }, mobile: { columnSpan: 1 } } }),
        box([
          mono('DIRECTORY', c.cream, 11),
          node('Navigation', { menuId: 'hf-footer-menu', label: 'Footer navigation', design: { desktop: { color: c.cream, fontSize: 13 }, mobile: { color: c.cream, fontSize: 13 } } }),
          hairline(true),
          body('All optical specs, SKUs, retrofit studies and photography are synthetic concept demonstrations. Replace with verified photometric data and authorised brand assets prior to publication.', c.mutedDark, 12, 620),
        ], { gap: 20, design: { desktop: { columnSpan: 7 }, mobile: { columnSpan: 1 } } }),
      ], { columns: 12, background: c.obsidian, padding: 64, gap: 48, design: { borderWidth: 1, borderColor: c.lineDark }, nodeLabel: '暗夜架构页脚' })], false),
    },
    {
      id: 'hf-product-card',
      name: '灯具选型卡片 · 暖石白高定',
      updated: date,
      data: data('HELIOFORM Product card', [box([
        boundImage(productBinding('builtin:image'), productBinding('builtin:name'), 250),
        box([
          boundMono(productBinding('builtin:sku'), 'HF-000', '#9a6b17'),
          boundHeading(productBinding('builtin:name'), 'Architectural luminaire', 24, c.ink, 'h3'),
          boundText(productBinding('builtin:category'), 'Optical series', c.inkMuted, 13),
          hairline(false),
          cardLink(productBinding('builtin:url'), 'Inspect optics & RFQ', c.ink),
        ], { gap: 12, padding: 24, inset: 24 }),
      ], {
        gap: 0,
        background: c.white,
        design: {
          desktop: { borderWidth: 1, borderColor: c.lineLight, borderRadius: 2, shadow: 'soft' },
          mobile: { borderRadius: 2 },
        },
      })], false),
    },
    {
      id: 'hf-case-card',
      name: '光影案例卡片 · 曜石暗夜',
      updated: date,
      data: data('HELIOFORM Case card', [box([
        boundImage(caseBinding('field:hf-case-image'), caseBinding('builtin:title'), 240),
        box([
          boundMono(caseBinding('field:hf-case-sector'), 'ARCHITECTURAL STUDY', c.gold),
          boundHeading(caseBinding('builtin:title'), 'Architectural lighting study', 24, c.cream, 'h3'),
          boundText(caseBinding('field:hf-case-summary'), 'Fictional spatial lighting brief.', c.mutedDark, 14),
          hairline(true),
          cardLink(caseBinding('builtin:url'), 'Read spatial study', c.gold),
        ], { gap: 14, padding: 24, inset: 24 }),
      ], {
        gap: 0,
        background: c.surface,
        design: {
          desktop: { borderWidth: 1, borderColor: c.lineDark, borderRadius: 2 },
          mobile: { borderRadius: 2 },
        },
      })], false),
    },
  ];

  // 核心专页：OEM 光电选型与定制方案页（工厂函数确保页面与模板资产节点 ID 严格独立）
  const buildSolutionsContent = (): ComponentData[] => [
    breadcrumbBar(true),
    pageIntro(
      'OEM & ODM OPTICAL ARCHITECTURE',
      'Engineer the beam.\nControl the room.',
      'Compare architectural luminaire families, configure finishes and dimming protocols, inspect before-and-after light quality and map every OEM gate before tooling.',
    ),
    band([
      box([
        mono('01 / SERIES MATRIX', '#9a6b17'),
        display('Three optical baselines, compared clearly.', 42, { color: c.ink, tabletSize: 34, mobileSize: 28 }),
        body('Compare mounting application, glare control, marine housing options and control protocols across every HELIOFORM series.', c.inkMuted, 16, 720),
      ], { gap: 14 }),
      comparisonTable('HELIOFORM Series Technical Comparison'),
    ], { background: c.stone, padding: 76, gap: 28, nodeLabel: '光学系列型号对比表' }),
    band([
      box([
        mono('02 / BESPOKE CONFIGURATION', '#9a6b17'),
        display('Tailor optics, metals and control buses.', 42, { color: c.ink, tabletSize: 34, mobileSize: 28 }),
      ], { gap: 14 }),
      customTabs(),
    ], { background: c.white, padding: 76, gap: 28, nodeLabel: '定制选项标签页' }),
    band([
      box([
        mono('03 / SPATIAL IMPACT · SIDE BY SIDE', c.gold),
        display('From flat overhead glare to sculptural warmth.', 42, { color: c.cream, tabletSize: 34, mobileSize: 28 }),
        body('Compare the same stone and timber lobby before and after replacing standard fluorescent panels with 2700K dark-baffle architectural fixtures.', c.mutedDark, 16, 760),
      ], { gap: 14 }),
      lightComparison('split'),
    ], { background: c.obsidian, padding: 80, gap: 28, nodeLabel: '暗夜光影前后对比 · 并排' }),
    band([
      box([
        mono('04 / OEM DELIVERY ROADMAP', '#9a6b17'),
        display('Five documented gates to export handover.', 42, { color: c.ink, tabletSize: 34, mobileSize: 28 }),
      ], { gap: 14 }),
      oemTimeline(),
    ], { background: c.stone, padding: 76, gap: 28, nodeLabel: '五阶段交付时间线' }),
    band([
      box([
        mono('05 / BUILT FOR TWO DECISION MAKERS', c.gold),
        display('Precision for architects. Predictability for buyers.', 40, { color: c.cream, tabletSize: 34, mobileSize: 28 }),
      ], { gap: 14 }),
      box([
        box([
          mono('SPECIFIERS & ARCHITECTS', c.gold),
          subhead('Zero-glare details & exact CCT binning', 24, c.cream),
          body('Review UGR cut-off, trimless plaster-in reveals, magnetic optical accessories and consistent 2700K–3000K colour rendering across adjacent fixtures.'),
          button('Inspect optical catalogue', '/catalog', 'outlineDark'),
        ], { gap: 16, padding: 32, inset: 32, background: c.surface, design: { desktop: { borderWidth: 1, borderColor: c.lineDark, height: '100%' } } }),
        box([
          mono('IMPORTERS & OEM BRANDS', c.gold),
          subhead('Unified housings, private labels & multi-SKU RFQs', 24, c.cream),
          body('Consolidate linear, spot and DALI-2 hubs on shared CNC anodised platforms with laser-etched branding, room-coded export crates and one unified RFQ.'),
          button('Start multi-SKU RFQ', '/contact', 'gold'),
        ], { gap: 16, padding: 32, inset: 32, background: c.surface, design: { desktop: { borderWidth: 1, borderColor: c.lineDark, height: '100%' } } }),
      ], { columns: 2, gap: 28 }),
    ], { background: c.obsidian, padding: 80, gap: 32, nodeLabel: '建筑师与采购双视角方案' }),
    goldCta('Ready to configure your architectural lighting range?'),
  ];

  const pages: PageItem[] = [
    page('hf-home', 'Home', '/'),
    page('hf-solutions', 'OEM Solutions', '/oem-solutions'),
    page('hf-catalog', 'Catalogue', '/catalog'),
    page('hf-product-detail', 'Product details', '/products/:slug'),
    page('hf-cases', 'Spatial Studies', '/cases'),
    page('hf-case-detail', 'Spatial Study', '/cases/:slug', caseModel.id),
    page('hf-quality', 'Quality & Logistics', '/quality-logistics'),
    page('hf-about', 'About', '/about'),
    page('hf-contact', 'RFQ & Contact', '/contact'),
  ];

  const editorData: SiteSnapshot['editorData'] = {
    'hf-home': data('HELIOFORM — Architectural Lighting & Modular Optics OEM', [
      // 1. 沉浸式暗夜全屏光影首屏：背景摄影大图 + 半透明暗黑玻璃浮层 + 12 列不对称构图
      band([
        box([
          box([
            mono('HELIOFORM · SWISS-INSPIRED OPTICAL OEM', c.gold),
            display('Sculpt space\nwith quiet light.', 72, { color: c.cream, level: 'h1', maxWidth: 640, tabletSize: 50, mobileSize: 38 }),
            body('Architectural linear grazers, museum micro-baffle spots and modular DALI-2 control hardware—engineered for private-label OEM brands and global hospitality projects.', '#d4d8e0', 17, 520),
            box([
              button('Explore OEM suite', '/oem-solutions', 'gold'),
              button('Start multi-SKU RFQ', '/contact', 'outlineDark'),
            ], {
              gap: 12,
              design: {
                desktop: { display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
                tablet: { display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
                mobile: { display: 'grid', columns: 1, gap: 10 },
              },
            }),
          ], {
            gap: 24,
            padding: 36,
            inset: 36,
            background: c.glass,
            design: {
              desktop: { columnSpan: 7, borderWidth: 1, borderColor: c.lineDark, borderRadius: 2 },
              mobile: { columnSpan: 1, paddingTop: 24, paddingBottom: 24, paddingLeft: 20, paddingRight: 20 },
            },
          }),
          box([
            mono('OPTICAL BASELINE / 2026 SPEC', c.gold),
            hairline(true),
            box([
              box([mono('COLOUR FIDELITY', c.mutedDark, 10), subhead('CRI 97+ / R9 > 90', 20, c.cream)], { gap: 4 }),
              box([mono('GLARE SHIELDING', c.mutedDark, 10), subhead('UGR < 13 Baffle', 20, c.cream)], { gap: 4 }),
              box([mono('CONTROL BUS', c.mutedDark, 10), subhead('DALI-2 · DMX · 0–10V', 20, c.cream)], { gap: 4 }),
              box([mono('RFQ WORKFLOW', c.mutedDark, 10), subhead('1–20 SKUs / Brief', 20, c.cream)], { gap: 4 }),
            ], { gap: 18 }),
            hairline(true),
            body('Fictional architectural lighting OEM concept. Every block, spec table and photo stays 100% editable.', c.mutedDark, 12),
          ], {
            gap: 18,
            padding: 32,
            inset: 32,
            background: c.glassCard,
            design: {
              desktop: { columnSpan: 5, borderWidth: 1, borderColor: '#363d4d', borderRadius: 2, shadow: 'strong' },
              mobile: { columnSpan: 1, paddingTop: 24, paddingBottom: 24, paddingLeft: 20, paddingRight: 20 },
            },
          }),
        ], { columns: 12, gap: 32, design: { desktop: { alignItems: 'end' } } }),
      ], {
        background: c.obsidian,
        image: heroImg,
        minHeight: 640,
        padding: 72,
        design: { justifyContent: 'end' },
        mobile: { minHeight: 520, paddingTop: 32, paddingBottom: 32 },
        nodeLabel: '沉浸式暗夜光影首屏',
      }),

      // 2. 精密工程指标带（4 列暗黑交互卡片，悬停上浮并点亮熔金边框）
      band([
        box([
          box([mono('01 / OPTICS', c.gold), subhead('Deep dark-chrome baffles', 18, c.cream), body('Hide the LED source completely for calm ceilings.', c.mutedDark, 14)], { gap: 8, padding: 22, inset: 22, background: c.obsidian, design: { desktop: { borderWidth: 1, borderColor: c.lineDark, borderRadius: 2, height: '100%' } } }),
          box([mono('02 / THERMAL', c.gold), subhead('CNC & brushed brass cores', 18, c.cream), body('Passive heat management engineered for long runs.', c.mutedDark, 14)], { gap: 8, padding: 22, inset: 22, background: c.obsidian, design: { desktop: { borderWidth: 1, borderColor: c.lineDark, borderRadius: 2, height: '100%' } } }),
          box([mono('03 / OEM FLEX', c.gold), subhead('Cut-to-length & RAL finish', 18, c.cream), body('Adapt standard baselines without starting from zero.', c.mutedDark, 14)], { gap: 8, padding: 22, inset: 22, background: c.obsidian, design: { desktop: { borderWidth: 1, borderColor: c.lineDark, borderRadius: 2, height: '100%' } } }),
          box([mono('04 / EXPORT', c.gold), subhead('Multi-SKU RFQ & room codes', 18, c.cream), body('Bundle fixtures and drivers into one structured quote.', c.mutedDark, 14)], { gap: 8, padding: 22, inset: 22, background: c.obsidian, design: { desktop: { borderWidth: 1, borderColor: c.lineDark, borderRadius: 2, height: '100%' } } }),
        ], { columns: 4, gap: 20 }),
      ], { background: c.surface, padding: 40, design: { borderWidth: 1, borderColor: c.lineDark }, nodeLabel: '四维精密工程指标带' }),

      // 3. 12 列不对称 Bento 硬件工艺展示（7 列精密光学微距大图 + 5 列暗夜工艺宣言）
      band([
        box([
          photo(opticsImg, 'Macro photograph of CNC matte black luminaire housings and brushed brass optical heatsinks', 500),
        ], { design: { desktop: { columnSpan: 7 }, mobile: { columnSpan: 1 } } }),
        box([
          mono('MODULAR HARDWARE ARCHITECTURE', c.gold),
          display('Machined to vanish.\nBuilt to endure.', 44, { color: c.cream, tabletSize: 36, mobileSize: 30 }),
          body('Every HELIOFORM luminaire shares a disciplined mechanical language: bead-blasted obsidian aluminium, forged brass thermal fins and magnetic optical lenses that swap in seconds.', c.mutedDark, 16),
          hairline(true),
          box([
            box([mono('SERIES', c.gold, 10), body('S10 Linear · M24 Gallery · X40 Exterior', c.cream, 14)], { gap: 4 }),
            box([mono('DELIVERABLES', c.gold, 10), body('IES photometrics · Golden sample · Export crates', c.cream, 14)], { gap: 4 }),
          ], { gap: 14 }),
          button('Inspect full OEM solutions', '/oem-solutions', 'outlineDark'),
        ], { gap: 22, padding: 12, inset: 8, design: { desktop: { columnSpan: 5 }, mobile: { columnSpan: 1 } } }),
      ], { columns: 12, background: c.obsidian, padding: 84, gap: 48, design: { alignItems: 'center' }, nodeLabel: '不对称硬件微距展示' }),

      // 4. 暗夜光影改造对比剧场（同机位 Before/After 交互切换）
      band([
        box([
          box([
            mono('LIGHTING TRANSFORMATION · BEFORE / AFTER', c.gold),
            display('See what precision optics change in the exact same room.', 44, { color: c.cream, maxWidth: 680, tabletSize: 34, mobileSize: 28 }),
          ], { gap: 14, design: { desktop: { columnSpan: 8 }, mobile: { columnSpan: 1 } } }),
          box([
            body('Toggle between flat cool-white overhead lighting and 2700K recessed grazing beams. Works smoothly on mobile and in zero-JavaScript environments.', c.mutedDark, 15),
          ], { design: { desktop: { columnSpan: 4, paddingTop: 20 }, mobile: { columnSpan: 1, paddingTop: 0 } } }),
        ], { columns: 12, gap: 32 }),
        lightComparison('toggle'),
      ], { background: c.surface, padding: 80, gap: 32, design: { borderWidth: 1, borderColor: c.lineDark }, nodeLabel: '同机位光影改造前后对比剧场' }),

      // 5. 强节奏切换至建筑暖石白：上方不对称导语 + 下方全宽选型对比矩阵（彻底杜绝窄列挤压断词）
      band([
        box([
          box([
            mono('SERIES SELECTION MATRIX', '#9a6b17'),
            display('Choose the right optical family first.', 42, { color: c.ink, tabletSize: 34, mobileSize: 28 }),
          ], { gap: 12, design: { desktop: { columnSpan: 7 }, mobile: { columnSpan: 1 } } }),
          box([
            body('Compare grazing, gallery accent and IP66 facade systems side by side before requesting golden samples or custom extrusion lengths.', c.inkMuted, 15),
            button('Compare full OEM workflow', '/oem-solutions', 'obsidian'),
          ], { gap: 16, design: { desktop: { columnSpan: 5 }, mobile: { columnSpan: 1 } } }),
        ], { columns: 12, gap: 32, design: { desktop: { alignItems: 'end' } } }),
        comparisonTable('HELIOFORM Architectural Series'),
      ], { background: c.stone, padding: 84, gap: 32, nodeLabel: '暖石白选型对比矩阵' }),

      // 6. 交互式光学与材质定制台（Tabs 实时切换） + 建筑暖石白精选产品动态循环
      band([
        box([
          mono('INTERACTIVE SPECIFIER DESK', '#9a6b17'),
          display('Click to explore optics, finishes and controls.', 42, { color: c.ink, tabletSize: 34, mobileSize: 28 }),
        ], { gap: 12 }),
        interactiveConfigTabs(),
      ], { background: c.white, padding: 80, gap: 28, nodeLabel: '首页交互式定制标签台' }),

      band([
        box([
          box([
            mono('FEATURED MODULES', '#9a6b17'),
            display('Six baselines ready for OEM specification.', 42, { color: c.ink, tabletSize: 34, mobileSize: 28 }),
          ], { gap: 12, design: { desktop: { columnSpan: 8 }, mobile: { columnSpan: 1 } } }),
          box([
            button('Browse full catalogue', '/catalog', 'outlineLight'),
          ], { design: { desktop: { columnSpan: 4, alignItems: 'end', justifyContent: 'end' }, mobile: { columnSpan: 1, alignItems: 'start' } } }),
        ], { columns: 12, gap: 24, design: { desktop: { alignItems: 'end' } } }),
        productLoop(3),
      ], { background: c.stone, padding: 84, gap: 36, nodeLabel: '首页精选光学模块' }),

      // 7. 回归曜石暗夜：3 篇建筑光影交付案例 + 原生大图灯箱赏析
      band([
        box([
          box([
            mono('SPATIAL CASE STUDIES', c.gold),
            display('Architecture shaped by beam and shadow.', 42, { color: c.cream, tabletSize: 34, mobileSize: 28 }),
          ], { gap: 12, design: { desktop: { columnSpan: 8 }, mobile: { columnSpan: 1 } } }),
          box([
            button('View all spatial studies', '/cases', 'outlineDark'),
          ], { design: { desktop: { columnSpan: 4, alignItems: 'end', justifyContent: 'end' }, mobile: { columnSpan: 1, alignItems: 'start' } } }),
        ], { columns: 12, gap: 24, design: { desktop: { alignItems: 'end' } } }),
        caseLoop(3),
      ], { background: c.obsidian, padding: 84, gap: 36, nodeLabel: '首页暗夜空间案例' }),

      // 8. 首页交互式大图灯箱 + 采购快问快答手风琴
      band([
        box([
          box([
            mono('LIGHTBOX GALLERY · CLICK TO EXPAND', '#9a6b17'),
            display('Inspect light details full-screen.', 36, { color: c.ink, mobileSize: 26 }),
            node('Gallery', {
              images: [
                { id: 'hf-home-gal-1', src: heroImg, alt: 'Architectural gallery corridor lit by warm recessed linear lighting', caption: 'S10 linear grazing · dusk corridor' },
                { id: 'hf-home-gal-2', src: opticsImg, alt: 'CNC matte black luminaire housings and brushed brass heatsinks', caption: 'CNC optics & forged brass heatsink' },
                { id: 'hf-home-gal-3', src: afterImg, alt: 'Hotel lobby after 2700K architectural lighting upgrade', caption: 'Hospitality lobby · 2700K retrofit' },
              ],
              ratio: '16/9',
              fit: 'cover',
              lightbox: true,
            }),
          ], { gap: 20, design: { desktop: { columnSpan: 7 }, mobile: { columnSpan: 1 } } }),
          box([
            mono('QUICK OEM FAQ · CLICK TO EXPAND', '#9a6b17'),
            display('Fast answers for buyers.', 36, { color: c.ink, mobileSize: 26 }),
            faq(4, false),
          ], { gap: 20, design: { desktop: { columnSpan: 5 }, mobile: { columnSpan: 1 } } }),
        ], { columns: 12, gap: 40, design: { desktop: { alignItems: 'start' } } }),
      ], { background: c.white, padding: 80, gap: 32, nodeLabel: '首页灯箱图库与交互问答' }),

      // 9. 熔金撞色终章 CTA
      goldCta(),
    ]),

    'hf-solutions': data('OEM & ODM Solutions — HELIOFORM', buildSolutionsContent()),

    'hf-catalog': data('Architectural Lighting Catalogue — HELIOFORM', [
      breadcrumbBar(true),
      pageIntro(
        'OPTICAL HARDWARE CATALOGUE',
        'Filter by series.\nBundle your RFQ.',
        'Search by SKU or filter across architectural linear, precision gallery optics and exterior control systems. Open any module to inspect photometrics and add it to your multi-SKU enquiry.',
      ),
      band([
        productLoop(6, true),
        box([
          mono('MULTI-PRODUCT RFQ READY', '#9a6b17'),
          body('Comparing multiple luminaires for one project? Open each product detail page to add items to your enquiry basket, or head straight to the RFQ form to select models together.', c.inkMuted, 14, 780),
          button('Open multi-SKU RFQ form', '/contact', 'obsidian'),
        ], { padding: 28, inset: 28, background: c.white, gap: 14, design: { desktop: { borderWidth: 1, borderColor: c.lineLight } } }),
      ], { background: c.stone, padding: 56, gap: 40, nodeLabel: '动态筛选产品目录' }),
      goldCta('Need a bespoke extrusion profile or custom beam angle?'),
    ]),

    'hf-product-detail': data('Product Detail Template — HELIOFORM', [
      breadcrumbBar(false),
      band([
        mono('ARCHITECTURAL LUMINAIRE SPECIFICATION', '#9a6b17'),
        button('Back to catalogue', '/catalog', 'outlineLight'),
      ], { background: c.stone, padding: 24, gap: 12, nodeLabel: '目录返回栏' }),
      band([
        node('ProductDetail', {
          productId: '',
          layout: 'split',
          imageHeight: 480,
          padding: 0,
          mobileOrder: 'specifications-first',
          cta: 'Request quote for this fixture',
          ctaColor: '#11141a',
          linkTarget: { kind: 'page', id: 'hf-contact' },
          showCustomFields: 'yes',
          design: { desktop: { width: '100%' }, mobile: { paddingTop: 0, paddingBottom: 0 } },
        }),
      ], { background: c.white, padding: 52, nodeLabel: '原生动态产品详情 · 选型优先' }),
      band([
        mono('SERIES COMPARISON', '#9a6b17'),
        display('Compare across the HELIOFORM lineup.', 36, { color: c.ink, tabletSize: 30, mobileSize: 26 }),
        comparisonTable('Optical Series Reference'),
      ], { background: c.stone, padding: 64, gap: 24, nodeLabel: '详情页型号对比' }),
      band([
        mono('SPECIFIER QUESTIONS', '#9a6b17'),
        display('Before sending your RFQ.', 36, { color: c.ink, tabletSize: 30, mobileSize: 26 }),
        faq(3, false),
      ], { background: c.white, padding: 64, gap: 24, nodeLabel: '采购常见问答' }),
      band([
        mono('RELATED MODULES', '#9a6b17'),
        display('Explore complementary optics.', 36, { color: c.ink, tabletSize: 30, mobileSize: 26 }),
        productLoop(3),
      ], { background: c.stone, padding: 64, gap: 28, nodeLabel: '关联灯具推荐' }),
    ]),

    'hf-cases': data('Spatial Studies — HELIOFORM', [
      breadcrumbBar(true),
      pageIntro(
        'SPATIAL STUDIES · CONCEPT ARCHIVE',
        'Light as an\narchitectural material.',
        'Fictional lighting briefs illustrating hospitality retrofits, brutalist gallery grazing and unified European private-label hardware programmes.',
      ),
      band([caseLoop(3)], { background: c.surface, padding: 64, nodeLabel: '暗夜空间案例列表' }),
      goldCta('Working on a hospitality, gallery or private-label lighting brief?'),
    ]),

    'hf-case-detail': data('Spatial Study Detail — HELIOFORM', [
      breadcrumbBar(true),
      band([
        button('Back to spatial studies', '/cases', 'outlineDark'),
        boundMono(caseBinding('field:hf-case-sector'), 'ARCHITECTURAL STUDY', c.gold),
        boundHeading(caseBinding('builtin:title'), 'Architectural lighting study', 52, c.cream, 'h1'),
        boundText(caseBinding('field:hf-case-summary'), 'Fictional project overview.', c.mutedDark, 18),
        mono('FICTIONAL CONCEPT STUDY · NO CLIENT CLAIM', c.mutedDark, 10),
      ], { background: c.obsidian, padding: 68, gap: 20, nodeLabel: '案例动态标题区' }),
      band([
        boundImage(caseBinding('field:hf-case-image'), caseBinding('builtin:title'), 500),
      ], { background: c.obsidian, padding: 0, mobile: { paddingTop: 0, paddingBottom: 0 }, nodeLabel: '案例全宽实景图' }),
      band([
        box([mono('01 / THE CHALLENGE', '#9a6b17'), display('Spatial context and visual goals.', 32, { color: c.ink, mobileSize: 26 })], { gap: 14, design: { desktop: { columnSpan: 4 }, mobile: { columnSpan: 1 } } }),
        box([
          boundText(caseBinding('field:hf-case-brief'), 'Describe the lighting challenge.', c.inkMuted, 16),
          hairline(false),
          mono('02 / OPTICAL SOLUTION', '#9a6b17'),
          subhead('How the fixture architecture answered the brief.', 24, c.ink),
          boundText(caseBinding('field:hf-case-solution'), 'Describe the optical and control approach.', c.inkMuted, 16),
          hairline(false),
          mono('03 / HANDOVER PACK', '#9a6b17'),
          subhead('Documentation and export readiness.', 24, c.ink),
          boundText(caseBinding('field:hf-case-handover'), 'Describe inspection and photometric deliverables.', c.inkMuted, 16),
        ], { gap: 24, design: { desktop: { columnSpan: 8 }, mobile: { columnSpan: 1 } } }),
      ], { columns: 12, background: c.stone, padding: 76, gap: 48, nodeLabel: '案例动态正文' }),
      band([
        mono('MORE STUDIES', c.gold),
        display('Continue exploring.', 36, { color: c.cream, mobileSize: 26 }),
        caseLoop(3),
      ], { background: c.obsidian, padding: 68, gap: 28 }),
      goldCta(),
    ]),

    'hf-quality': data('Quality & Logistics — HELIOFORM', [
      breadcrumbBar(true),
      pageIntro(
        'PHOTOMETRIC QC & EXPORT LOGISTICS',
        'Verified optics.\nProtected transit.',
        'Consistent colour binning, 100% power-cycle ageing and foam-cradled export crates ensure fixtures arrive on site exactly as specified.',
      ),
      band([
        box([
          mono('QUALITY VERIFICATION GATES', '#9a6b17'),
          display('Four checkpoints before every export crate closes.', 38, { color: c.ink, tabletSize: 32, mobileSize: 26 }),
          body('Replace these illustrative checkpoints with your own spectrometer tolerance, ageing duration and pre-shipment inspection records.', c.inkMuted, 16),
          photo(opticsImg, 'Precision machined luminaire modules on dark slate inspection table', 300),
        ], { gap: 20, design: { desktop: { columnSpan: 5 }, mobile: { columnSpan: 1 } } }),
        box([qualityTimeline()], { design: { desktop: { columnSpan: 7 }, mobile: { columnSpan: 1 } } }),
      ], { columns: 12, background: c.stone, padding: 76, gap: 48, nodeLabel: '质检与出货时间线' }),
      band([
        box([
          mono('EXPORT PACKING SPECIFICATION', c.gold),
          display('Engineered for long-haul freight and site sorting.', 38, { color: c.cream, tabletSize: 32, mobileSize: 26 }),
          body('Confirming foam cradle density, moisture barriers and room-coded carton labels upfront keeps installation teams moving smoothly on arrival.'),
          button('Discuss export packing', '/contact', 'gold'),
        ], { gap: 20, design: { desktop: { columnSpan: 5 }, mobile: { columnSpan: 1 } } }),
        box([
          box([
            mono('01 / INNER CRADLES', c.gold, 11),
            body('Anti-static foam sleeves for optical lenses and reinforced channels for long linear extrusions.', c.cream, 15),
            hairline(true),
            mono('02 / ROOM-CODED LABELS', c.gold, 11),
            body('SKU, CCT/CRI bin, project zone code, carton count and net/gross weight printed on outer flaps.', c.cream, 15),
            hairline(true),
            mono('03 / PALLET & DOCUMENTS', c.gold, 11),
            body('Heat-treated export pallets, corner guards, packing list and pre-loading photographs.', c.cream, 15),
          ], { gap: 18, padding: 32, inset: 32, background: c.surface, design: { desktop: { borderWidth: 1, borderColor: c.lineDark } } }),
        ], { design: { desktop: { columnSpan: 7 }, mobile: { columnSpan: 1 } } }),
      ], { columns: 12, background: c.obsidian, padding: 76, gap: 48, nodeLabel: '出口包装规范' }),
      band([
        mono('VISUAL ARCHIVE · LIGHTBOX', '#9a6b17'),
        display('Optics, spaces and retrofit benchmarks.', 36, { color: c.ink, mobileSize: 26 }),
        node('Gallery', {
          images: [
            { id: 'hf-gal-1', src: heroImg, alt: 'Architectural gallery corridor illuminated by warm linear wall-washers', caption: 'S10 linear grazing concept · dusk corridor atmosphere.' },
            { id: 'hf-gal-2', src: opticsImg, alt: 'CNC matte black luminaire housings and brushed brass heatsinks', caption: 'Precision optical baffles and thermal cores · macro concept.' },
            { id: 'hf-gal-3', src: afterImg, alt: 'Hotel lobby after 2700K architectural lighting retrofit', caption: 'Hospitality lobby after 2700K architectural lighting upgrade.' },
          ],
          ratio: '16/9',
          fit: 'cover',
          lightbox: true,
        }),
      ], { background: c.white, padding: 72, gap: 28, nodeLabel: '光影实景图库' }),
      goldCta('Need IES files, finish swatches or export packing specs?'),
    ]),

    'hf-about': data('About HELIOFORM', [
      breadcrumbBar(true),
      pageIntro(
        'ABOUT / HELIOFORM',
        'Quiet architecture.\nHonest engineering.',
        'HELIOFORM demonstrates how a high-specification B2B lighting OEM can present photometric discipline, spatial contrast and multi-SKU procurement in one fully editable website.',
      ),
      band([
        box([photo(heroImg, 'Minimalist concrete and brushed aluminum corridor lit by warm recessed linear lighting', 460)], { design: { desktop: { columnSpan: 7 }, mobile: { columnSpan: 1 } } }),
        box([
          mono('NATIVE EDITABLE ARCHITECTURE', '#9a6b17'),
          display('Editorial polish without locked code.', 38, { color: c.ink, tabletSize: 32, mobileSize: 26 }),
          body('Every asymmetric grid, comparison column, before-and-after photo and multi-product RFQ form is built solely from native Form Studio components. Swap photography, translate into multiple languages or bulk-update SKUs via Excel anytime.', c.inkMuted, 16),
          button('Explore OEM solutions', '/oem-solutions', 'obsidian'),
        ], { gap: 20, design: { desktop: { columnSpan: 5 }, mobile: { columnSpan: 1 } } }),
      ], { columns: 12, background: c.white, padding: 76, gap: 48, design: { alignItems: 'center' }, nodeLabel: '品牌理念图文区' }),
      band([
        mono('SPECIFIER & BUYER FAQ', '#9a6b17'),
        display('Common procurement questions.', 38, { color: c.ink, mobileSize: 28 }),
        faq(faqItems.length, false),
      ], { background: c.stone, padding: 72, gap: 28, nodeLabel: '采购常见问答' }),
      band([
        mono('CONCEPT DEMONSTRATION NOTICE', c.gold),
        display('Fictional brand. Real B2B storefront system.', 34, { color: c.cream, mobileSize: 26 }),
        body('HELIOFORM, its S10/M24/X40 SKUs, photometric specs and spatial studies are synthetic demonstrations. Replace all text, specifications and imagery with verified company materials before public launch.', c.mutedDark, 15, 820),
      ], { background: c.obsidian, padding: 56, gap: 16 }),
      goldCta(),
    ]),

    'hf-contact': data('RFQ & Contact — HELIOFORM', [
      breadcrumbBar(true),
      pageIntro(
        'MULTI-PRODUCT OEM RFQ',
        'One brief for\nyour full schedule.',
        'Select one or more reference luminaires below, enter quantities and optical notes per item, and submit a consolidated enquiry directly to the engineering desk.',
      ),
      band([
        box([
          mono('PREPARING YOUR BRIEF', '#9a6b17'),
          display('Details that accelerate technical quoting.', 34, { color: c.ink, mobileSize: 26 }),
          body('Multi-product RFQ is active on this form. Fixtures added from the catalogue or product detail pages appear automatically in your list.', c.inkMuted, 15),
          hairline(false),
          mono('HELPFUL INPUTS', c.ink, 11),
          body('Reference SKUs & estimated quantities\nTarget CCT (2700K / 3000K / Tunable) & CRI\nControl protocol (DALI-2 / 0–10V / DMX)\nCustom length, finish or private-label scope\nDestination country & target delivery window', c.inkMuted, 15),
          button('Compare series before quoting', '/oem-solutions', 'outlineLight'),
          body('Demonstration mode: public preview submissions are disabled. After installation and mail setup, submitted RFQs are stored in the admin inbox.', c.inkMuted, 12),
        ], { gap: 18, design: { desktop: { columnSpan: 5 }, mobile: { columnSpan: 1 } } }),
        box([
          inquiry(),
          body('Do not include confidential project drawings or personal data in this demonstration.', c.inkMuted, 12),
        ], {
          gap: 18,
          padding: 32,
          inset: 32,
          background: c.white,
          design: {
            desktop: { columnSpan: 7, borderWidth: 1, borderColor: c.lineLight, borderRadius: 2, shadow: 'soft' },
            mobile: { columnSpan: 1, paddingLeft: 18, paddingRight: 18, paddingTop: 22, paddingBottom: 22 },
          },
        }),
      ], { columns: 12, background: c.stone, padding: 72, gap: 48, nodeLabel: '多产品照明询价表单区' }),
    ]),
  };

  // 附带 1 份可复用页面模板资产
  const pageTemplates: PageTemplate[] = [
    {
      id: 'hf-template-solution-landing',
      name: 'HELIOFORM 光学选型与定制方案落地页',
      description: '暗夜与暖石白交替的高定 B2B 方案落地页模板，内置型号对比表、定制选项标签、同机位前后对比、5 阶段时间线与双角色方案。',
      kind: 'page',
      updated: date,
      data: data('HELIOFORM OEM solution landing template', buildSolutionsContent()),
    },
  ];

  const theme: SiteTheme = {
    primary: c.gold,
    background: c.obsidian,
    text: c.cream,
    radius: 2,
    font: 'Inter',
    headingFont: 'Georgia',
  };

  return {
    schemaVersion: protocol.snapshot,
    pages,
    editorData,
    products,
    media: [
      { id: 'hf-media-hero', name: 'helioform-hero.jpg', url: heroImg, kind: 'image', folder: 'HELIOFORM concept', size: '', alt: 'Minimalist concrete and brushed aluminum corridor lit by warm recessed linear lighting' },
      { id: 'hf-media-optics', name: 'helioform-optics.jpg', url: opticsImg, kind: 'image', folder: 'HELIOFORM concept', size: '', alt: 'Precision CNC matte black anodized luminaire housings and brushed brass heatsinks' },
      { id: 'hf-media-before', name: 'helioform-before.jpg', url: beforeImg, kind: 'image', folder: 'HELIOFORM concept', size: '', alt: 'Contemporary hotel lobby before architectural lighting upgrade under flat cool-white light' },
      { id: 'hf-media-after', name: 'helioform-after.jpg', url: afterImg, kind: 'image', folder: 'HELIOFORM concept', size: '', alt: 'The same hotel lobby after 2700K architectural lighting upgrade with warm grazing contrast' },
    ],
    theme,
    settings: {
      name: 'HELIOFORM',
      description: 'HELIOFORM is a fictional architectural lighting and modular optical hardware OEM demonstration website with before-and-after spatial comparisons, series matrices and multi-SKU RFQ.',
      email: '',
      language: 'en',
    },
    sharedBlocks,
    contentModels: [productModel, caseModel],
    contentEntries: cases,
    forms: [form],
    pageTemplates,
    taxonomies: [{
      id: 'hf-product-categories',
      name: '光学产品系列',
      source: 'product',
      modelId: productModel.id,
      terms: [
        { id: 'hf-cat-linear', label: 'Architectural Linear', slug: 'architectural-linear' },
        { id: 'hf-cat-optics', label: 'Precision Optics', slug: 'precision-optics' },
        { id: 'hf-cat-exterior', label: 'Exterior & Control', slug: 'exterior-control' },
      ],
    }],
    redirects: [],
    // 纯 CSS 动效引擎（零 JavaScript）：首屏交错入场、毛玻璃景深、卡片悬浮、图片镜头微缩放、表格/时间线交互高亮与滚动显现
    customCode: {
      global: {
        css: `
@keyframes hfFadeUp {
  from { opacity: 0; transform: translateY(22px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes hfTabReveal {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes hfGoldPulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(229, 169, 60, 0.35); }
  50% { box-shadow: 0 0 0 8px rgba(229, 169, 60, 0); }
}

/* 0. 全站流体自适应基线：360px 手机 → 768px 平板 → 1024px 笔记本 → 1920px 大屏连续无死角缩放 */
html, body, .editor-site, .editor-site-page {
  max-width: 100%;
  overflow-x: clip;
}
.editor-site-page * {
  box-sizing: border-box;
  min-width: 0;
}
.editor-site-page h1 {
  font-size: clamp(2.05rem, 4.2vw, 4.4rem) !important;
  line-height: 1.08 !important;
  overflow-wrap: break-word;
}
.editor-site-page main h2:not(.site-project-timeline > h2):not(.site-image-comparison > h2) {
  font-size: clamp(1.55rem, 2.9vw, 2.65rem) !important;
  line-height: 1.14 !important;
}
.editor-site-page main > .editor-site-section {
  padding-inline: clamp(16px, 4vw, 48px) !important;
}

/* 三级自适应卡片网格与中屏/小屏顶栏自适应折叠 */
header h2,
header .editor-site-action.ant-btn {
  white-space: nowrap !important;
}
@container form-site (max-width: 1024px) {
  .editor-site-loop-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
    gap: 20px !important;
  }
  .site-menu-desktop > ul {
    gap: 10px !important;
  }
  .site-managed-navigation a,
  .site-managed-navigation summary {
    padding: 6px 7px !important;
    font-size: 12.5px !important;
  }
}
/* <= 880px（含 768px 平板竖屏）提前折叠为单行汉堡抽屉导航，彻底杜绝顶栏折成两行 */
@container form-site (max-width: 880px) {
  header .site-menu-desktop {
    display: none !important;
  }
  header .site-menu-mobile {
    display: inline-flex !important;
    position: relative !important;
  }
}
@container form-site (max-width: 620px) {
  .editor-site-loop-grid {
    grid-template-columns: minmax(0, 1fr) !important;
    gap: 20px !important;
  }
  .editor-site-action.ant-btn {
    max-width: 100%;
  }
  .site-tabs > .site-tab > label {
    font-size: 12px;
    padding-inline: 6px;
    white-space: nowrap;
  }
}

/* 1. 首屏交错入场 + 毛玻璃景深 */
.editor-site-page > main > section:first-of-type .editor-site-slot > .editor-site-container {
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  animation: hfFadeUp 0.78s cubic-bezier(0.16, 1, 0.3, 1) both;
}
.editor-site-page > main > section:first-of-type .editor-site-slot > .editor-site-container:nth-child(2) {
  animation-delay: 0.14s;
}

/* 2. 现代 CSS 滚动驱动入场显现（不支持的浏览器自动保持可见） */
@supports (animation-timeline: view()) {
  .editor-site-page > main > section:not(:first-of-type) {
    animation: hfFadeUp linear both;
    animation-timeline: view();
    animation-range: entry 4% cover 24%;
  }
}

/* 3. 按钮悬浮微升与光泽交互（页眉纯文字品牌按钮隐藏附属箭头） */
header .editor-site-slot > .editor-site-container:first-child .editor-site-action.ant-btn .anticon {
  display: none;
}
.editor-site-action.ant-btn {
  position: relative;
  overflow: hidden;
  transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.28s ease, background-color 0.25s ease, border-color 0.25s ease !important;
}
.editor-site-action.ant-btn:hover {
  transform: translateY(-2px);
  box-shadow: 0 10px 26px rgba(229, 169, 60, 0.22);
}
.editor-site-action.ant-btn:active {
  transform: translateY(0);
}

/* 4. 吸顶毛玻璃页眉 + 托管导航栏熔金滑动下划线 + 二级下拉菜单暗黑浮层 */
.editor-site-page > header,
.editor-site > .editor-site-page > .editor-site-header,
header:has(.site-managed-navigation) {
  position: sticky;
  top: 0;
  z-index: 60;
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
}
.site-managed-navigation a,
.site-managed-navigation summary {
  position: relative;
  color: #f3f1eb;
  font-weight: 500;
  letter-spacing: 0.3px;
  transition: color 0.24s ease;
}
.site-menu-desktop > ul > li > a::after,
.site-menu-desktop > ul > li > details > summary::after {
  content: "";
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: 3px;
  height: 1.5px;
  background: #e5a93c;
  transform: scaleX(0);
  transform-origin: left center;
  transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1);
}
.site-managed-navigation a:hover,
.site-managed-navigation summary:hover {
  color: #e5a93c !important;
}
.site-menu-desktop > ul > li > a:hover::after,
.site-menu-desktop > ul > li > details:hover > summary::after,
.site-menu-desktop > ul > li > details[open] > summary::after {
  transform: scaleX(1);
}
.site-menu-desktop details > ul {
  min-width: 230px;
  margin-top: 6px;
  background: rgba(14, 18, 26, 0.96) !important;
  backdrop-filter: blur(16px);
  border: 1px solid #2e3646 !important;
  border-radius: 4px !important;
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.55) !important;
  animation: hfTabReveal 0.24s cubic-bezier(0.16, 1, 0.3, 1) both;
}
.site-menu-desktop details > ul a {
  width: 100%;
  box-sizing: border-box;
  border-radius: 2px;
  transition: background-color 0.2s ease, color 0.2s ease, padding-left 0.2s ease;
}
.site-menu-desktop details > ul a:hover {
  background-color: rgba(229, 169, 60, 0.12);
  padding-left: 14px;
}
.site-menu-mobile > summary {
  border: 1px solid #363d4d;
  border-radius: 3px;
  padding: 6px 12px;
  list-style: none;
}
.site-menu-mobile > summary::-webkit-details-marker {
  display: none;
}
/* 使用视口单位定位移动抽屉面板宽度，避免受右侧窄按钮父容器 94% 宽度限制导致逐字母折行 */
.site-menu-panel,
.site-navigation-block .site-menu-panel {
  position: absolute !important;
  top: calc(100% + 10px) !important;
  right: 0 !important;
  left: auto !important;
  inset-inline: auto 0 !important;
  width: min(300px, calc(100vw - 32px)) !important;
  min-width: 240px !important;
  max-height: calc(100dvh - 84px) !important;
  padding: 16px 18px !important;
  background: rgba(14, 18, 26, 0.98) !important;
  backdrop-filter: blur(18px);
  border: 1px solid #2e3646 !important;
  border-radius: 4px !important;
  box-shadow: 0 20px 48px rgba(0, 0, 0, 0.65) !important;
}
.site-menu-panel li,
.site-menu-panel a,
.site-menu-panel summary {
  white-space: normal !important;
  word-break: normal !important;
  overflow-wrap: break-word !important;
  display: block;
  width: 100%;
}
.ant-breadcrumb a,
.ant-breadcrumb li,
.ant-breadcrumb .ant-breadcrumb-separator {
  color: inherit !important;
}
.ant-breadcrumb a:hover {
  color: #e5a93c !important;
}

/* 5. 产品与案例卡片悬浮上浮 + 图片镜头推近 + 多产品询价按钮防遮挡排版 */
.editor-site-loop-grid > * {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: auto !important;
  transition: transform 0.35s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.35s ease, border-color 0.3s ease;
}
.editor-site-loop-grid .site-rfq-button {
  position: relative;
  z-index: 3;
  align-self: flex-start;
  margin-bottom: 12px;
}
.editor-site-loop-grid > *:hover {
  transform: translateY(-6px);
  box-shadow: 0 18px 40px rgba(9, 11, 15, 0.22);
}
.editor-site-loop-grid figure,
.editor-site-loop-grid .editor-site-image,
.site-gallery figure {
  overflow: hidden;
}
.editor-site-loop-grid img,
.site-gallery img {
  transition: transform 0.55s cubic-bezier(0.16, 1, 0.3, 1);
}
.editor-site-loop-grid > *:hover img,
.site-gallery figure:hover img {
  transform: scale(1.05);
}

/* 6. 指标带暗黑卡片悬浮点亮熔金边 */
.editor-site-page > main > section:nth-of-type(2) .editor-site-slot > .editor-site-container {
  transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.3s ease, background-color 0.3s ease;
}
.editor-site-page > main > section:nth-of-type(2) .editor-site-slot > .editor-site-container:hover {
  transform: translateY(-4px);
  border-color: #e5a93c !important;
  background-color: #161b26 !important;
}

/* 7. 标签页与前后对比切换平滑淡入动画 */
.site-tabs .site-tab > label {
  cursor: pointer;
  transition: color 0.22s ease, border-color 0.22s ease, background-color 0.22s ease;
}
.site-tabs .site-tab > label:hover {
  color: #e5a93c;
}
.site-tabs .site-tab > input:checked ~ section {
  animation: hfTabReveal 0.42s cubic-bezier(0.16, 1, 0.3, 1) both;
}

/* 8. 型号对比表行悬浮高亮 + 窄屏首列永不断词 */
.site-comparison-scroll tbody th {
  white-space: nowrap;
}
.site-comparison-scroll tbody tr {
  transition: background-color 0.2s ease;
}
.site-comparison-scroll tbody tr:hover {
  background-color: rgba(229, 169, 60, 0.09);
}

/* 9. 时间线节点交互高亮与光晕 */
.site-project-milestones > li {
  transition: transform 0.25s ease, border-color 0.25s ease;
}
.site-project-milestones > li:hover {
  transform: translateX(4px);
  border-inline-start-color: #e5a93c;
}
.site-project-milestones > li::before {
  animation: hfGoldPulse 3.2s ease-in-out infinite;
}

/* 10. 手风琴展开交互平滑过渡 */
.site-accordion details {
  transition: border-color 0.24s ease, background-color 0.24s ease;
}
.site-accordion details:hover,
.site-accordion details[open] {
  border-color: #e5a93c;
}
.site-accordion details[open] > *:not(summary) {
  animation: hfTabReveal 0.32s cubic-bezier(0.16, 1, 0.3, 1) both;
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
`.trim(),
        js: '',
        cssEnabled: true,
        jsEnabled: false,
      },
      pages: {},
    },
    siteLayout: {
      header: { mode: 'block', blockId: 'hf-header', menuId: 'hf-menu' },
      footer: { mode: 'block', blockId: 'hf-footer', menuId: 'hf-footer-menu' },
      menus: [
        {
          id: 'hf-menu',
          name: '主导航（含二级下拉菜单）',
          items: [
            { id: 'hf-menu-home', label: 'Home', target: { kind: 'page', id: 'hf-home' } },
            {
              id: 'hf-menu-products-group',
              label: 'Products & OEM',
              children: [
                { id: 'hf-menu-sub-catalog', label: 'Optical Catalogue (6 SKUs)', target: { kind: 'page', id: 'hf-catalog' } },
                { id: 'hf-menu-sub-solutions', label: 'OEM & ODM Solutions', target: { kind: 'page', id: 'hf-solutions' } },
                { id: 'hf-menu-sub-quality', label: 'Photometric QC & Logistics', target: { kind: 'page', id: 'hf-quality' } },
              ],
            },
            { id: 'hf-menu-cases', label: 'Spatial Studies', target: { kind: 'page', id: 'hf-cases' } },
            { id: 'hf-menu-about', label: 'About', target: { kind: 'page', id: 'hf-about' } },
            { id: 'hf-menu-contact', label: 'Contact', target: { kind: 'page', id: 'hf-contact' } },
          ],
        },
        {
          id: 'hf-footer-menu',
          name: '页脚导航',
          items: [
            { id: 'hf-footer-solutions', label: 'OEM Solutions', target: { kind: 'page', id: 'hf-solutions' } },
            { id: 'hf-footer-catalog', label: 'Catalogue', target: { kind: 'page', id: 'hf-catalog' } },
            { id: 'hf-footer-cases', label: 'Spatial Studies', target: { kind: 'page', id: 'hf-cases' } },
            { id: 'hf-footer-quality', label: 'Quality & Logistics', target: { kind: 'page', id: 'hf-quality' } },
            { id: 'hf-footer-about', label: 'About', target: { kind: 'page', id: 'hf-about' } },
            { id: 'hf-footer-contact', label: 'RFQ & Contact', target: { kind: 'page', id: 'hf-contact' } },
          ],
        },
      ],
    },
  };
}
