import { expect, it } from 'vitest';
import { parseResults, webSearchProvider } from '../src/server/web-search.js';

const html = `
<div class="result results_links results_links_deep result--ad"><a rel="nofollow" class="result__a" href="https://ads.example/">Ad</a></div>
<div class="result results_links results_links_deep web-result "><div class="links_main links_deep result__body">
<a rel="nofollow" class="result__a" href="https://www.th-deg.de/en/postgraduate">Postgraduate Studies | DIT</a>
<a class="result__snippet" href="https://www.th-deg.de/en/postgraduate"><b>Master</b> Degrees at DIT &amp; more&#x27;s</a>
</div></div>
<div class="result results_links web-result "><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fpage&amp;rut=x">Wrapped</a></div>
<div class="result results_links web-result "><a rel="nofollow" class="result__a" href="javascript:alert(1)">Bad</a></div>`;

it('parses organic results, unwraps redirects, and skips ads and unsafe links', () => {
  expect(parseResults(html)).toEqual([
    {
      title: 'Postgraduate Studies | DIT',
      url: 'https://www.th-deg.de/en/postgraduate',
      snippet: "Master Degrees at DIT & more's",
    },
    { title: 'Wrapped', url: 'https://example.org/page', snippet: '' },
  ]);
});

it('defaults to DuckDuckGo and rejects unknown providers', () => {
  expect(webSearchProvider()).toBe('duckduckgo');
  expect(webSearchProvider('disabled')).toBe('disabled');
  expect(() => webSearchProvider('parallel')).toThrow();
});
