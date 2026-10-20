// Recorded shapes of search provider answers, trimmed. No test contacts the network.

/** A SearXNG /search?format=json answer. */
export const searxngAnswer = {
  query: 'fulldots self hosted',
  number_of_results: 0,
  results: [
    {
      url: 'https://github.com/asasemahmed/FullDots',
      title: 'FullDots: self-hosted &amp; local-first AI coworkers',
      content: 'Run   <b>AI coworkers</b> on your own server.\n No telemetry.',
      engine: 'brave',
      engines: ['brave', 'mojeek'],
      score: 2,
      category: 'general',
    },
    // The same page from another engine is listed once.
    {
      url: 'https://github.com/asasemahmed/FullDots',
      title: 'FullDots',
      content: '',
      engine: 'mojeek',
    },
    { url: 'javascript:alert(1)', title: 'Unsafe', content: '' },
    { url: 'https://user:pass@example.org/', title: 'Credentials' },
    { title: 'No address' },
    { url: 'https://docs.example.org/setup', content: 'Setup guide.' },
  ],
  answers: [],
  corrections: [],
  infoboxes: [],
  suggestions: [],
  unresponsive_engines: [['google', 'CAPTCHA']],
};

/** A SearXNG answer when every engine failed. */
export const searxngAllEnginesFailed = {
  query: 'anything',
  number_of_results: 0,
  results: [],
  unresponsive_engines: [
    ['google', 'CAPTCHA'],
    ['duckduckgo', 'too many requests'],
    ['brave', 'timeout'],
  ],
};

/** What DuckDuckGo's HTML endpoint serves to an IP address it blocks. */
export const duckDuckGoAnomalyPage = `<!DOCTYPE html><html><head><title>DuckDuckGo</title></head><body>
<form id="challenge-form" action="//duckduckgo.com/anomaly.js?sv=html&amp;cc=sre" method="POST">
<div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>
<div class="anomaly-modal__description">Please complete the following challenge to confirm this search was made by a human.</div>
</form></body></html>`;

/** A DuckDuckGo HTML browser page (links in [Title, URL, Snippet] order plus an ad). */
export const duckDuckGoBrowserPage = {
  title: 'fulldots at DuckDuckGo',
  text: [
    'All Regions',
    'Sponsored',
    'Buy Cloud Agents',
    'ads.example.com/buy',
    'Sponsored cloud hosting.',
    'FullDots: self-hosted & local-first AI coworkers',
    'github.com/asasemahmed/FullDots',
    'Run AI coworkers on your own server with persistent computers.',
    'Postgraduate Studies | DIT',
    'https://www.th-deg.de/en/postgraduate',
    'Master Degrees at Deggendorf Institute of Technology.',
  ].join('\n'),
  elements: [
    { ref: 'e1', role: 'searchbox', name: 'Search' },
    { ref: 'e2', role: 'button', name: 'Search' },
    { ref: 'e3', role: 'link', name: 'Sponsored' },
    { ref: 'e4', role: 'link', name: 'Buy Cloud Agents' },
    { ref: 'e5', role: 'link', name: 'ads.example.com/buy' },
    {
      ref: 'e6',
      role: 'link',
      name: 'FullDots: self-hosted & local-first AI coworkers',
    },
    { ref: 'e7', role: 'link', name: 'github.com/asasemahmed/FullDots' },
    {
      ref: 'e8',
      role: 'link',
      name: 'Run AI coworkers on your own server with persistent computers.',
    },
    { ref: 'e9', role: 'link', name: 'Postgraduate Studies | DIT' },
    { ref: 'e10', role: 'link', name: 'https://www.th-deg.de/en/postgraduate' },
    {
      ref: 'e11',
      role: 'link',
      name: 'Master Degrees at Deggendorf Institute of Technology.',
    },
    { ref: 'e12', role: 'link', name: 'Feedback' },
  ],
};

/** A Brave Search browser page (compound links with clean breadcrumb paths and visible text snippets). */
export const braveBrowserPage = {
  title: 'fulldots - Brave Search',
  text: [
    'All',
    'Images',
    'github.com › asasemahmed › FullDots',
    'FullDots - Self-hosted AI coworkers',
    'Open-source platform for local-first AI coworkers and persistent computers.',
    'docs.fulldots.dev › setup › computers',
    'Setting up Dot computers',
    'Step-by-step guide to running isolated containers for each Dot.',
  ].join('\n'),
  elements: [
    { ref: 'b1', role: 'searchbox', name: 'Search the web' },
    { ref: 'b2', role: 'link', name: 'All' },
    { ref: 'b3', role: 'link', name: 'Images' },
    {
      ref: 'b4',
      role: 'link',
      name: 'github.com › asasemahmed › FullDots FullDots - Self-hosted AI coworkers',
    },
    {
      ref: 'b5',
      role: 'link',
      name: 'docs.fulldots.dev › setup › computers Setting up Dot computers',
    },
  ],
};

/** A Startpage browser page ([URL, Title] link pairs with visible text snippets). */
export const startpageBrowserPage = {
  title: 'Startpage Search Results',
  text: [
    'Anonymous View',
    'https://github.com/asasemahmed/FullDots',
    'FullDots Repository',
    'Self-hosted AI coworkers with persistent computers and approval gates.',
  ].join('\n'),
  elements: [
    { ref: 's1', role: 'link', name: 'Anonymous View' },
    {
      ref: 's2',
      role: 'link',
      name: 'https://github.com/asasemahmed/FullDots',
    },
    { ref: 's3', role: 'link', name: 'FullDots Repository' },
  ],
};

/** A Bing browser page (title links paired with visible URL and snippet lines in page text). */
export const bingBrowserPage = {
  title: 'fulldots - Search',
  text: [
    'Web',
    'FullDots on GitHub',
    'https://github.com/asasemahmed/FullDots',
    'Local-first AI coworkers with their own browser and terminal.',
  ].join('\n'),
  elements: [
    { ref: 'm1', role: 'searchbox', name: 'Enter your search here' },
    { ref: 'm2', role: 'link', name: 'FullDots on GitHub' },
  ],
};

/** A Google consent wall followed by results with a truncated breadcrumb and a clean URL. */
export const googleConsentPage = {
  title: 'Before you continue to Google Search',
  text: 'Before you continue to Google. We use cookies and data to deliver and maintain Google services.',
  elements: [
    { ref: 'g1', role: 'button', name: 'Sign in' },
    { ref: 'g2', role: 'button', name: 'Reject all' },
    { ref: 'g3', role: 'button', name: 'Accept all' },
  ],
};

export const googleBrowserPage = {
  title: 'fulldots - Google Search',
  text: [
    'Truncated Result Title',
    'https://example.org › docs › ... › guide',
    'Should not guess a truncated breadcrumb.',
    'FullDots Documentation',
    'https://docs.fulldots.dev/guide/search',
    'Configure web search with the Dot browser or SearXNG.',
  ].join('\n'),
  elements: [
    {
      ref: 'g10',
      role: 'link',
      name: 'Truncated Result Title https://example.org › docs › ... › guide',
    },
    {
      ref: 'g11',
      role: 'link',
      name: 'FullDots Documentation https://docs.fulldots.dev/guide/search',
    },
  ],
};
