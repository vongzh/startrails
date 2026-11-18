import { regionOf } from '../collections/index.ts';
import type { GroupStrategy, PolicyGroup, RuleSource } from '../ir/index.ts';

/**
 * 策略组图标自动识别与多客户端映射（纯函数，零 IO）。
 *
 * 分层识别优先级：
 *   1. 组名首部自带的 Emoji（用户显式指定，永远最高优先）；
 *   2. 组名匹配（服务/分类 → 地区/别名 → 策略角色）；
 *   3. 关联规则来源（命中该组的规则列表文件名或内联规则）；
 *   4. 成员特征（全 DIRECT / 全 REJECT / 仅含单一地区节点）；
 *   5. 策略类型兜底（url-test → ⚡ / fallback → 🔁 / 其他 → 🌐）。
 *
 * 图标地址采用公共开源资产的不可变版本：
 * - 非国旗图标：Microsoft Fluent Emoji 3D（MIT，pinned commit on jsDelivr）；
 * - 国旗图标：Twemoji 72x72 PNG（CC-BY 4.0，pinned v15.1.0 on jsDelivr）；
 * - Quantumult X：不兼容大图 CDN，使用官方 SF Symbols `<symbol>.system`。
 */

const FLUENT_BASE =
  'https://cdn.jsdelivr.net/gh/microsoft/fluentui-emoji@1ffb34c752ecf5d402f04cfb4b392c77f57c54bc/assets/';
const TWEMOJI_FLAG_BASE =
  'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/';

const FLUENT_PATHS: Readonly<Record<string, string>> = {
  '🍃': 'Leaf%20fluttering%20in%20wind/3D/leaf_fluttering_in_wind_3d.png',
  '🛑': 'Stop%20sign/3D/stop_sign_3d.png',
  '🐟': 'Fish/3D/fish_3d.png',
  '🛡': 'Shield/3D/shield_3d.png',
  '🌏': 'Globe%20showing%20asia-australia/3D/globe_showing_asia-australia_3d.png',
  '🌍': 'Globe%20showing%20europe-africa/3D/globe_showing_europe-africa_3d.png',
  '🏠': 'House/3D/house_3d.png',
  '🌐': 'Globe%20with%20meridians/3D/globe_with_meridians_3d.png',
  '📶': 'Antenna%20bars/3D/antenna_bars_3d.png',
  '🔀': 'Shuffle%20tracks%20button/3D/shuffle_tracks_button_3d.png',
  '📢': 'Loudspeaker/3D/loudspeaker_3d.png',
  '📹': 'Video%20camera/3D/video_camera_3d.png',
  '🎥': 'Movie%20camera/3D/movie_camera_3d.png',
  '🧸': 'Teddy%20bear/3D/teddy_bear_3d.png',
  '🎬': 'Clapper%20board/3D/clapper_board_3d.png',
  '🍿': 'Popcorn/3D/popcorn_3d.png',
  '⚽': 'Soccer%20ball/3D/soccer_ball_3d.png',
  '📺': 'Television/3D/television_3d.png',
  '🎵': 'Musical%20note/3D/musical_note_3d.png',
  '🎧': 'Headphone/3D/headphone_3d.png',
  '🎶': 'Musical%20notes/3D/musical_notes_3d.png',
  '📲': 'Mobile%20phone%20with%20arrow/3D/mobile_phone_with_arrow_3d.png',
  '🤖': 'Robot/3D/robot_3d.png',
  '🔷': 'Large%20blue%20diamond/3D/large_blue_diamond_3d.png',
  '🐦': 'Bird/3D/bird_3d.png',
  '♾': 'Infinity/3D/infinity_3d.png',
  '📣': 'Megaphone/3D/megaphone_3d.png',
  '🎙': 'Studio%20microphone/3D/studio_microphone_3d.png',
  '👽': 'Alien/3D/alien_3d.png',
  '📕': 'Closed%20book/3D/closed_book_3d.png',
  '💬': 'Speech%20balloon/3D/speech_balloon_3d.png',
  '📞': 'Telephone%20receiver/3D/telephone_receiver_3d.png',
  '🐙': 'Octopus/3D/octopus_3d.png',
  '🐳': 'Spouting%20whale/3D/spouting_whale_3d.png',
  '📝': 'Memo/3D/memo_3d.png',
  '📱': 'Mobile%20phone/3D/mobile_phone_3d.png',
  '🔞': 'No%20one%20under%20eighteen/3D/no_one_under_eighteen_3d.png',
  '🎨': 'Artist%20palette/3D/artist_palette_3d.png',
  '💳': 'Credit%20card/3D/credit_card_3d.png',
  '🪙': 'Coin/3D/coin_3d.png',
  '🛒': 'Shopping%20cart/3D/shopping_cart_3d.png',
  '☁': 'Cloud/3D/cloud_3d.png',
  'Ⓜ': 'Circled%20m/3D/circled_m_3d.png',
  '🍎': 'Red%20apple/3D/red_apple_3d.png',
  '🔍': 'Magnifying%20glass%20tilted%20left/3D/magnifying_glass_tilted_left_3d.png',
  '🎮': 'Video%20game/3D/video_game_3d.png',
  '🎓': 'Graduation%20cap/3D/graduation_cap_3d.png',
  '📰': 'Newspaper/3D/newspaper_3d.png',
  '📧': 'E-mail/3D/e-mail_3d.png',
  '🏦': 'Bank/3D/bank_3d.png',
  '👥': 'Busts%20in%20silhouette/3D/busts_in_silhouette_3d.png',
  '📥': 'Inbox%20tray/3D/inbox_tray_3d.png',
  '🎯': 'Bullseye/3D/bullseye_3d.png',
  '🔁': 'Repeat%20button/3D/repeat_button_3d.png',
  '⚖': 'Balance%20scale/3D/balance_scale_3d.png',
  '♻': 'Recycling%20symbol/3D/recycling_symbol_3d.png',
  '🎛': 'Control%20knobs/3D/control_knobs_3d.png',
  '🏡': 'House%20with%20garden/3D/house_with_garden_3d.png',
  '💰': 'Money%20bag/3D/money_bag_3d.png',
  '⭐': 'Star/3D/star_3d.png',
  '🛠': 'Hammer%20and%20wrench/3D/hammer_and_wrench_3d.png',
  '🗺': 'World%20map/3D/world_map_3d.png',
  '🚀': 'Rocket/3D/rocket_3d.png',
  '⚡': 'High%20voltage/3D/high_voltage_3d.png',
};

const QUANX_SYMBOLS: Readonly<Record<string, string>> = {
  '🎛': 'hand.point.up.left.fill',
  '♻': 'speedometer',
  '🍃': 'leaf.fill',
  '🛑': 'hand.raised.fill',
  '🐟': 'fish.fill',
  '🌏': 'globe.asia.australia.fill',
  '🌍': 'globe.europe.africa.fill',
  '🏠': 'house.fill',
  '🌐': 'network',
  '📢': 'bell.badge.fill',
  '📹': 'play.rectangle.fill',
  '🎥': 'film.fill',
  '🎞': 'film.fill',
  '🧸': 'sparkles',
  '🎬': 'film.stack.fill',
  '🎦': 'film.stack.fill',
  '📺': 'tv.fill',
  '🎵': 'music.note',
  '🎧': 'headphones',
  '🟢': 'headphones',
  '🎶': 'music.note.list',
  '📲': 'paperplane.fill',
  '✈': 'paperplane.fill',
  '💬': 'bubble.left.and.bubble.right.fill',
  '🤖': 'brain.head.profile',
  '🔷': 'sparkle',
  '✨': 'sparkle',
  '🐦': 'bird.fill',
  '🕊': 'bird.fill',
  '♾': 'infinity',
  '🎙': 'bubble.left.and.bubble.right.fill',
  '🐙': 'chevron.left.forwardslash.chevron.right',
  '☁': 'cloud.fill',
  '💳': 'creditcard.fill',
  '🪙': 'bitcoinsign.circle.fill',
  '📦': 'cart.fill',
  'Ⓜ': 'square.grid.2x2.fill',
  '🪟': 'square.grid.2x2.fill',
  '🍎': 'apple.logo',
  '🔍': 'magnifyingglass',
  '🔎': 'magnifyingglass',
  '🎮': 'gamecontroller.fill',
  '🎯': 'arrow.right.circle.fill',
  '🚀': 'airplane',
  '⚡': 'bolt.fill',
  '🔁': 'arrow.triangle.2.circlepath',
  '⚖': 'scalemass.fill',
  '🧩': 'square.stack.3d.up.fill',
  '🎓': 'graduationcap.fill',
  '📰': 'newspaper.fill',
  '📧': 'envelope.fill',
  '🏦': 'building.columns.fill',
  '⚽': 'soccerball',
  '👥': 'person.2.fill',
  '📥': 'arrow.down.circle.fill',
  '🛡': 'lock.shield.fill',
  '📶': 'speedometer',
  '🍿': 'play.tv.fill',
  '👽': 'person.3.fill',
  '📕': 'book.closed.fill',
  '📞': 'phone.fill',
  '🐳': 'shippingbox.fill',
  '🎨': 'paintpalette.fill',
  '🛒': 'cart.fill',
  '🏡': 'house.fill',
  '💰': 'dollarsign.circle.fill',
  '⭐': 'star.fill',
  '🛠': 'wrench.and.screwdriver.fill',
  '🗺': 'map.fill',
  '🔀': 'arrow.triangle.branch',
  '📣': 'megaphone.fill',
  '📝': 'note.text',
  '📱': 'iphone',
  '🔞': 'eye.slash.fill',
};

const URL_TO_EMOJI = new Map<string, string>(
  Object.entries(FLUENT_PATHS).map(([emoji, path]) => [`${FLUENT_BASE}${path}`, emoji]),
);

const stripVariation = (emoji: string): string =>
  emoji.replace(/\uFE0F|\uFE0E/g, '');

const FLAG_ALIAS: Readonly<Record<string, string>> = {
  UK: 'GB',
  UM: 'US',
};

/** 两位地区码 → 旗帜 Emoji（如 `HK` → `🇭🇰`；`UK` → `🇬🇧`）。 */
export function flagEmojiOf(rawCode: string): string | undefined {
  const upper = rawCode.trim().toUpperCase();
  const code = FLAG_ALIAS[upper] ?? upper;
  if (!/^[A-Z]{2}$/.test(code)) return undefined;
  const first = 0x1f1e6 + (code.charCodeAt(0) - 65);
  const second = 0x1f1e6 + (code.charCodeAt(1) - 65);
  return String.fromCodePoint(first, second);
}

/** 旗帜 Emoji → 两位大写地区码（`🇬🇧` → `GB`）。 */
export function countryCodeOfFlag(emoji: string): string | undefined {
  const scalars = [...stripVariation(emoji.trim())].map((char) => char.codePointAt(0) ?? 0);
  if (scalars.length !== 2) return undefined;
  if (scalars.some((cp) => cp < 0x1f1e6 || cp > 0x1f1ff)) return undefined;
  return String.fromCharCode((scalars[0] ?? 0) - 0x1f1e6 + 65, (scalars[1] ?? 0) - 0x1f1e6 + 65);
}

/** 提取组名开头的 Emoji（包含国旗双码点及变体选择符）；跳过 ASCII 数字、`#`、`*`。 */
export function leadingEmoji(name: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 0) return undefined;
  const chars = [...trimmed];
  const first = chars[0];
  if (first === undefined) return undefined;
  const cp0 = first.codePointAt(0) ?? 0;
  if (cp0 < 0x80) return undefined;

  // 国旗由两个 Regional Indicator (U+1F1E6..U+1F1FF) 组成。
  if (cp0 >= 0x1f1e6 && cp0 <= 0x1f1ff && chars[1] !== undefined) {
    const cp1 = chars[1].codePointAt(0) ?? 0;
    if (cp1 >= 0x1f1e6 && cp1 <= 0x1f1ff) return `${first}${chars[1]}`;
  }

  // 检测 Emoji / Pictograph 属性，兼容带有 FE0F 变体选择符的序列。
  if (/\p{Extended_Pictographic}/u.test(first)) {
    const second = chars[1];
    return second === '\uFE0F' ? `${first}${second}` : first;
  }
  return undefined;
}

interface EmojiRule {
  readonly emoji: string;
  readonly words: readonly string[];
  readonly phrases: readonly string[];
  readonly exact?: readonly string[];
}

const STREAMING_EMOJIS = new Set(['🎥', '📹', '🧸', '🎬', '📺', '🍿', '🎵']);

/** 按 CamelCase 与非字母数字切词，使 `AkamaiCloud` 不会误命中 `icloud`。 */
function tokenize(name: string): string[] {
  const words: string[] = [];
  let current = '';
  for (let index = 0; index < name.length; index += 1) {
    const ch = name[index] ?? '';
    if (!/[A-Za-z0-9]/.test(ch)) {
      if (current.length > 0) {
        words.push(current.toLowerCase());
        current = '';
      }
      continue;
    }
    if (current.length > 0) {
      const prev = current[current.length - 1] ?? '';
      const next = name[index + 1] ?? '';
      const lowerToUpper = /[a-z]/.test(prev) && /[A-Z]/.test(ch);
      const acronymEnd = /[A-Z]/.test(prev) && /[A-Z]/.test(ch) && /[a-z]/.test(next);
      const letterToDigit = /[A-Za-z]/.test(prev) && /[0-9]/.test(ch);
      if (lowerToUpper || acronymEnd || letterToDigit) {
        words.push(current.toLowerCase());
        current = '';
      }
    }
    current += ch;
  }
  if (current.length > 0) words.push(current.toLowerCase());
  return words;
}

function matchesEntry(entry: EmojiRule, words: readonly string[], lowered: string): boolean {
  if (entry.phrases.some((phrase) => lowered.includes(phrase))) return true;
  if (
    entry.exact !== undefined &&
    entry.exact.length > 0 &&
    entry.exact.includes(words.join(' ')) &&
    !/[^\x00-\x7f]/.test(lowered)
  ) {
    return true;
  }
  const spellings = new Set(words);
  for (let len = 2; len <= 3; len += 1) {
    for (let start = 0; start <= words.length - len; start += 1) {
      spellings.add(words.slice(start, start + len).join(''));
    }
  }
  return entry.words.some((keyword) => {
    const parts = keyword.split(' ');
    if (spellings.has(parts.join(''))) return true;
    if (parts.length <= 1 || parts.length > words.length) return false;
    for (let start = 0; start <= words.length - parts.length; start += 1) {
      if (parts.every((part, offset) => words[start + offset] === part)) return true;
    }
    return false;
  });
}

const SERVICE_TABLE: readonly EmojiRule[] = [
  { emoji: '🍃', words: [], phrases: ['应用净化'] },
  {
    emoji: '🛑',
    words: ['reject', 'adblock', 'ad block', 'ads', 'advertising', 'advertisement', 'blocklist'],
    phrases: ['广告拦截', '全球拦截', '拦截', '广告', '去广告'],
    exact: ['block'],
  },
  {
    emoji: '🐟',
    words: ['final', 'match', 'fallback rule'],
    phrases: ['漏网之鱼', '兜底', '其他流量', '其它流量', '剩余流量'],
    exact: ['others'],
  },
  { emoji: '🛡️', words: ['privacy', 'tracking', 'tracker', 'antitracking'], phrases: ['隐私', '追踪', '跟踪', '泄漏', '泄露'] },
  { emoji: '🌏', words: ['china media', 'asia media'], phrases: ['国内媒体', '国内视频', '国内影视', '港台媒体', '日韩媒体', '港澳台媒体', '亚洲媒体'] },
  { emoji: '🌍', words: ['global media', 'streaming', 'foreign media', 'international media'], phrases: ['国外媒体', '国际媒体', '海外媒体', '流媒体'] },
  { emoji: '🏠', words: ['lan', 'local area network', 'private network', 'intranet'], phrases: ['局域网', '内网', '私有网络'] },
  { emoji: '🌐', words: ['dns', 'httpdns', 'doh'], phrases: ['域名解析'] },
  { emoji: '📶', words: ['speedtest', 'speed test', 'network test'], phrases: ['测速工具', '测速网站', '网络测试'] },
  { emoji: '🔀', words: ['non standard port'], phrases: ['非标端口', '非标准端口'] },
  { emoji: '📢', words: ['fcm', 'google fcm'], phrases: ['谷歌fcm', '谷歌 fcm', '谷歌推送'] },
  { emoji: '📹', words: ['youtube', 'youtube music'], phrases: ['油管'] },
  { emoji: '🎥', words: ['netflix'], phrases: ['奈飞', '网飞'] },
  { emoji: '🧸', words: ['disney', 'disney plus', 'disneyplus'], phrases: ['迪士尼'] },
  {
    emoji: '🎬',
    words: ['hbo', 'hbo max', 'prime video', 'amazon prime', 'hulu', 'apple tv', 'appletv', 'paramount', 'peacock'],
    phrases: ['亚马逊视频'],
    exact: ['max'],
  },
  { emoji: '🍿', words: ['emby', 'jellyfin', 'plex'], phrases: [] },
  { emoji: '⚽', words: ['dazn', 'espn'], phrases: [] },
  {
    emoji: '📺',
    words: ['bilibili', 'bahamut', 'abema', 'abematv', 'iqiyi', 'youku', 'tvb', 'anime', 'twitch', 'niconico', 'viu', 'mytvsuper'],
    phrases: ['哔哩', '巴哈姆特', '爱奇艺', '优酷', '动漫', '番剧', '动画', '直播'],
  },
  { emoji: '🎵', words: ['tiktok', 'douyin', 'bytedance'], phrases: ['抖音', '字节跳动', '抖快'] },
  { emoji: '🎧', words: ['spotify', 'apple music', 'deezer', 'tidal', 'soundcloud', 'qobuz'], phrases: [] },
  { emoji: '🎶', words: ['netease music', 'music', 'kkbox', 'joox'], phrases: ['网易音乐', '网易云音乐', '音乐'] },
  { emoji: '📲', words: ['telegram'], phrases: ['电报'] },
  {
    emoji: '🤖',
    words: ['ai', 'aigc', 'openai', 'chatgpt', 'claude', 'anthropic', 'copilot', 'perplexity', 'grok', 'deepseek', 'midjourney'],
    phrases: ['ai平台', 'ai 平台', 'ai服务', '人工智能'],
  },
  { emoji: '🔷', words: ['gemini', 'bard'], phrases: [] },
  { emoji: '🐦', words: ['twitter'], phrases: ['推特'], exact: ['x', 'twitter x'] },
  { emoji: '♾️', words: ['facebook', 'instagram', 'meta', 'whatsapp', 'threads'], phrases: ['脸书'] },
  { emoji: '📣', words: ['weibo'], phrases: ['微博'] },
  { emoji: '🎙️', words: ['discord'], phrases: [] },
  { emoji: '👽', words: ['reddit'], phrases: [] },
  { emoji: '📕', words: ['xiaohongshu', 'rednote'], phrases: ['小红书'] },
  { emoji: '💬', words: ['wechat', 'line', 'signal', 'kakaotalk', 'messenger', 'im'], phrases: ['微信', '即时通讯', '通讯', '聊天'] },
  { emoji: '📞', words: ['talkatone', 'skype', 'zoom', 'voip'], phrases: ['通话', '电话'] },
  { emoji: '🐙', words: ['github', 'gitlab'], phrases: [] },
  { emoji: '🐳', words: ['docker'], phrases: [] },
  { emoji: '📝', words: ['notion', 'evernote', 'obsidian'], phrases: [] },
  { emoji: '📱', words: ['xiaomi', 'samsung'], phrases: ['小米', '三星'] },
  { emoji: '🔞', words: ['pornhub', 'ehentai', 'nsfw'], phrases: [] },
  { emoji: '🎨', words: ['pixiv', 'adobe', 'figma', 'canva'], phrases: [] },
  { emoji: '💳', words: ['paypal', 'stripe', 'visa', 'wise'], phrases: ['支付'] },
  { emoji: '🪙', words: ['binance', 'okx', 'crypto', 'coinbase', 'bybit'], phrases: ['加密货币', '货币', '币安'] },
  { emoji: '🛒', words: ['amazon', 'ebay', 'shopee', 'shopping', 'shop'], phrases: ['购物', '电商', '亚马逊', '淘宝', '京东', '阿里巴巴'] },
  { emoji: '☁️', words: ['google cloud', 'azure'], phrases: [] },
  { emoji: 'Ⓜ️', words: ['microsoft', 'bing', 'onedrive', 'office', 'outlook', 'office365', 'windows', 'teams'], phrases: ['微软'] },
  { emoji: '🍎', words: ['apple', 'icloud', 'app store', 'appstore', 'testflight', 'itunes'], phrases: ['苹果'] },
  { emoji: '🔍', words: ['google', 'gmail'], phrases: ['谷歌'] },
  { emoji: '☁️', words: ['cloudflare', 'aws', 'azure', 'google cloud', 'oracle cloud', 'pikpak', 'dropbox', 'mega'], phrases: ['网盘', '云盘'] },
  { emoji: '🎮', words: ['game', 'games', 'gaming', 'steam', 'epic', 'playstation', 'xbox', 'nintendo', 'blizzard', 'videogame'], phrases: ['游戏'] },
  { emoji: '🎓', words: ['scholar', 'academic', 'education'], phrases: ['学术', '教育', '论文'] },
  { emoji: '📰', words: ['news'], phrases: ['新闻', '资讯'] },
  { emoji: '📧', words: ['mail', 'email'], phrases: ['邮件', '邮箱'] },
  { emoji: '🏦', words: ['bank', 'banking', 'finance'], phrases: ['银行', '金融'] },
  { emoji: '⚽', words: ['sport', 'sports'], phrases: ['体育'] },
  { emoji: '👥', words: ['social'], phrases: ['社交'] },
  { emoji: '📥', words: ['download', 'downloads', 'p2p', 'bt', 'torrent'], phrases: ['下载', 'pt站'] },
  { emoji: '🎬', words: ['video', 'videos', 'movie', 'movies', 'film', 'films'], phrases: ['影视', '视频', '电影', '剧集', '追剧'] },
  { emoji: '🎯', words: ['direct', 'global direct', 'domestic'], phrases: ['全球直连', '直连', '直接连接', '国内', '大陆'], exact: ['mainland'] },
];

const ROLE_TABLE: readonly EmojiRule[] = [
  { emoji: '🔁', words: ['fallback', 'failover', 'backup'], phrases: ['故障转移', '故障切换', '故转', '备用', '容灾'] },
  { emoji: '⚖️', words: ['load balance', 'loadbalance', 'balance', 'round robin'], phrases: ['负载均衡', '均衡', '轮询'] },
  { emoji: '♻️', words: ['auto', 'auto select', 'url test', 'automatic', 'best', 'lowest latency'], phrases: ['自动', '优选', '延迟最低', '最低延迟', '低延迟'] },
  { emoji: '📶', words: [], phrases: ['测速'] },
  { emoji: '🎛️', words: ['manual', 'manual select', 'manual switch'], phrases: ['手动', '手选', '自选', '策略选择', '选择地区'], exact: ['select', 'selector'] },
  { emoji: '🏡', words: ['residential', 'home broadband'], phrases: ['家宽', '家庭宽带', '原生'] },
  { emoji: '💰', words: ['cheap', 'budget'], phrases: ['便宜', '低价', '低倍率', '省流'] },
  { emoji: '⭐', words: ['premium', 'vip', 'iplc', 'iepl'], phrases: ['高级', '优质', '精品', '高速', '专线'] },
  { emoji: '🛠️', words: ['self hosted', 'selfhosted'], phrases: ['自建'] },
  { emoji: '🌍', words: ['foreign', 'overseas', 'international', 'outside'], phrases: ['国外', '国际', '海外', '境外'] },
  { emoji: '🗺️', words: ['other', 'others', 'other regions'], phrases: ['其他', '其它'] },
  { emoji: '🌐', words: ['all proxies', 'all nodes'], phrases: ['全部', '所有'], exact: ['all'] },
  { emoji: '🚀', words: ['proxy', 'proxy select', 'node select', 'node selection', 'nodes', 'node', 'default'], phrases: ['节点选择', '代理', '节点', '加速', '默认'] },
  { emoji: '🌐', words: ['global'], phrases: ['全球'] },
];

const RULE_LIST_TABLE: readonly EmojiRule[] = [
  {
    emoji: '🎯',
    words: ['china domain', 'china ip', 'china company', 'china media', 'local area network'],
    phrases: [],
    exact: ['china', 'cn', 'chinadomain', 'chinaip', 'chinamax', 'direct', 'gfw direct'],
  },
  {
    emoji: '🚀',
    words: ['gfw', 'gfwlist', 'proxy gfwlist', 'proxy lite', 'proxy media', 'global'],
    phrases: [],
    exact: ['proxy', 'proxylite'],
  },
  { emoji: '🛑', words: ['ban ad', 'ban program ad', 'ban easylist', 'reject'], phrases: [] },
];

const GROUP_REGION_ALIASES: readonly { readonly phrase: string; readonly code: string }[] = [
  { phrase: '加坡', code: 'SG' },
  { phrase: '欧洲', code: 'EU' },
  { phrase: '欧盟', code: 'EU' },
];

function recognizeNameEmoji(name: string, allowRegion = true): string | undefined {
  const words = tokenize(name);
  const lowered = name.toLowerCase();
  const hit = SERVICE_TABLE.find((entry) => matchesEntry(entry, words, lowered));
  if (hit !== undefined) return hit.emoji;

  if (allowRegion) {
    const alias = GROUP_REGION_ALIASES.find((item) => lowered.includes(item.phrase))?.code
      ?? (words.some((w) => w === 'europe' || w === 'eu') ? 'EU' : undefined);
    const code = alias ?? regionOf(name);
    if (code !== undefined) {
      const flag = flagEmojiOf(code);
      if (flag !== undefined) return flag;
    }
  }

  return ROLE_TABLE.find((entry) => matchesEntry(entry, words, lowered))?.emoji;
}

function stemOfUrl(url: string): string {
  const clean = url.split(/[?#]/)[0] ?? url;
  const last = clean.split('/').pop() ?? '';
  return last.replace(/\.(list|txt|yaml|yml|srs|mrs)$/i, '');
}

function emojiFromRules(groupName: string, ruleSources: readonly RuleSource[]): string | undefined {
  const counts = new Map<string, number>();
  const order: string[] = [];
  const record = (emoji: string | undefined): void => {
    if (emoji === undefined) return;
    if (!counts.has(emoji)) order.push(emoji);
    counts.set(emoji, (counts.get(emoji) ?? 0) + 1);
  };

  for (const source of ruleSources) {
    if (source.kind === 'external') {
      if (source.policy !== groupName) continue;
      const stem = stemOfUrl(source.url);
      const words = tokenize(stem);
      const lowered = stem.toLowerCase();
      const matched = RULE_LIST_TABLE.find((entry) => matchesEntry(entry, words, lowered))?.emoji
        ?? recognizeNameEmoji(stem, false);
      record(matched);
      continue;
    }
    for (const rule of source.rules) {
      if (rule.policy !== groupName) continue;
      if (rule.condition.type === 'match') record('🐟');
      else if (rule.condition.type === 'geoip') {
        const val = rule.condition.value.toUpperCase();
        if (val === 'CN') record('🎯');
        else if (val === 'LAN' || val === 'PRIVATE') record('🏠');
      }
    }
  }

  if (order.length === 0) return undefined;
  if (order.length > 1 && order.every((emoji) => STREAMING_EMOJIS.has(emoji))) return '🎬';
  let best = order[0];
  let bestCount = -1;
  for (const emoji of order) {
    const count = counts.get(emoji) ?? 0;
    if (count > bestCount) {
      bestCount = count;
      best = emoji;
    }
  }
  return best;
}

function emojiFromMembers(members: readonly string[]): string | undefined {
  if (members.length === 0) return undefined;
  const upper = new Set(members.map((m) => m.trim().toUpperCase()));
  if (upper.size === 1 && upper.has('DIRECT')) return '🎯';
  if ([...upper].every((m) => m.startsWith('REJECT'))) return '🛑';
  const regionCodes = new Set<string>();
  for (const member of members) {
    const code = regionOf(member);
    if (code === undefined) return undefined;
    regionCodes.add(code);
  }
  if (regionCodes.size === 1) {
    const [only] = [...regionCodes];
    if (only !== undefined) return flagEmojiOf(only);
  }
  return undefined;
}

export function fallbackEmoji(strategy?: GroupStrategy): string {
  if (strategy === 'url-test') return '⚡';
  if (strategy === 'fallback') return '🔁';
  return '🌐';
}

export function recognizeGroupEmoji(
  group: Pick<PolicyGroup, 'name' | 'members' | 'strategy'>,
  ruleSources: readonly RuleSource[] = [],
): string | undefined {
  return (
    recognizeNameEmoji(group.name) ??
    (ruleSources.length > 0 ? emojiFromRules(group.name, ruleSources) : undefined) ??
    emojiFromMembers(group.members)
  );
}

export function resolveGroupEmoji(
  group: Pick<PolicyGroup, 'name' | 'members' | 'strategy'>,
  ruleSources: readonly RuleSource[] = [],
): string {
  return leadingEmoji(group.name) ?? recognizeGroupEmoji(group, ruleSources) ?? fallbackEmoji(group.strategy);
}

/** 由 Emoji 解析远程图标 PNG 地址（国旗走 Twemoji 72x72，其余走 Fluent Emoji 3D）。 */
export function iconUrlForEmoji(emoji: string): string | undefined {
  const country = countryCodeOfFlag(emoji);
  if (country !== undefined) {
    const alias = FLAG_ALIAS[country] ?? country;
    const hex = [...(flagEmojiOf(alias) ?? '')]
      .map((ch) => (ch.codePointAt(0) ?? 0).toString(16))
      .join('-');
    return hex.length > 0 ? `${TWEMOJI_FLAG_BASE}${hex}.png` : undefined;
  }
  const key = stripVariation(emoji.trim());
  const path = FLUENT_PATHS[key];
  return path === undefined ? undefined : `${FLUENT_BASE}${path}`;
}

/** Quantumult X 使用系统 SF Symbols（`<name>.system`），避免远端 PNG 不渲染。 */
export function quanxIconForEmoji(emoji: string): string | undefined {
  const key = stripVariation(emoji.trim());
  const symbol = QUANX_SYMBOLS[key];
  return symbol === undefined ? undefined : `${symbol}.system`;
}

/** 判断一条图标 URL 是否为 Twemoji 国旗图标（供 Surge 去重：组名首已带国旗时不再重复写 icon-url）。 */
export function isFlagIconUrl(url: string): boolean {
  return url.startsWith(TWEMOJI_FLAG_BASE);
}

export interface ResolvedGroupIcon {
  readonly emoji: string;
  readonly url?: string;
  readonly quanx?: string;
}

export function resolveGroupIcon(
  group: Pick<PolicyGroup, 'name' | 'members' | 'strategy' | 'icon'>,
  ruleSources: readonly RuleSource[] = [],
): ResolvedGroupIcon {
  const emoji = resolveGroupEmoji(group, ruleSources);
  const custom = group.icon?.trim();
  if (custom !== undefined && custom.length > 0) {
    const mappedEmoji = URL_TO_EMOJI.get(custom);
    const quanx = custom.endsWith('.system')
      ? custom
      : mappedEmoji !== undefined
        ? (quanxIconForEmoji(mappedEmoji) ?? custom)
        : custom;
    return { emoji: mappedEmoji ?? emoji, url: custom, ...(quanx === undefined ? {} : { quanx }) };
  }
  const url = iconUrlForEmoji(emoji);
  const quanx = quanxIconForEmoji(emoji);
  return {
    emoji,
    ...(url === undefined ? {} : { url }),
    ...(quanx === undefined ? {} : { quanx }),
  };
}

/** 为未显式设置 icon 的策略组填充自动匹配图标（返回新数组，不改原对象）。 */
export function applyAutoGroupIcons(
  groups: readonly PolicyGroup[],
  ruleSources: readonly RuleSource[] = [],
): PolicyGroup[] {
  return groups.map((group) => {
    if (group.icon !== undefined && group.icon.length > 0) return group;
    const url = iconUrlForEmoji(resolveGroupEmoji(group, ruleSources));
    return url === undefined ? group : { ...group, icon: url };
  });
}
