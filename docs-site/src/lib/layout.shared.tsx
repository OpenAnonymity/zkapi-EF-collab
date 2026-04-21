import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, gitConfig } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="font-semibold tracking-tight">{appName}</span>
      ),
    },
    links: [
      { text: 'Documentation', url: '/docs' },
      { text: 'Protocol', url: '/docs/protocol' },
      { text: 'API Reference', url: '/docs/api-reference' },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
