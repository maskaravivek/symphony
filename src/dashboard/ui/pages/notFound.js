import { h } from '../lib/dom.js';

export function createNotFoundPage(ctx) {
  ctx.setTitle('Not found');
  return {
    refresh() {},
    render() {
      ctx.draw(
        h('header.page-head', h('div.page-head-main', h('h1.page-title', 'Page not found'))),
        h('p.empty', 'Nothing lives at ', h('code', ctx.params.path), '. ', h('a', { href: '#/' }, 'Back to the overview'), '.'),
      );
    },
  };
}
