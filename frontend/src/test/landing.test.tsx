import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiContext } from '../api/apiContext';
import type { ApiClient } from '../api/client';
import { AppRoutes } from '../AppRoutes';
import { AuthContext, type AuthState } from '../auth/authContext';
import type { FrontendProfile } from '../config';

/** UI-1: the public landing page (Part 1 §1.2). */

const consoleApi = {
  get: vi.fn(async () => {
    throw new Error('the landing page never calls the console API');
  }),
} as unknown as ApiClient;

function landing(opts: { user?: AuthState['user']; profile?: FrontendProfile } = {}) {
  const auth: AuthState = { user: opts.user ?? null, loading: false, signIn: vi.fn(), signOut: vi.fn() };
  return render(
    <AuthContext.Provider value={auth}>
      <ApiContext.Provider value={consoleApi}>
        <MemoryRouter initialEntries={['/']}>
          <AppRoutes profile={opts.profile ?? 'local'} />
        </MemoryRouter>
      </ApiContext.Provider>
    </AuthContext.Provider>,
  );
}

function demoConfig(body: unknown | 'fail') {
  const fetchMock = vi.fn(async () =>
    body === 'fail' ? Promise.reject(new Error('offline')) : new Response(JSON.stringify(body), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const SECTION_HEADINGS = [
  'Your shopper wants it today. Your partner store has it.',
  'Three ways a ready-to-buy shopper slips away',
  'How Qwikspot works',
  'One story, three winners',
  'Turn buying intent into sales, online or in your partner stores.',
  'More customers who arrive ready to buy.',
  'Know before you go.',
  'Attract new buyers. Keep them coming back.',
  'AI that proposes. Rules that decide.',
  'Built on trust',
  'Ready to turn “need it today” into a sale?',
];

afterEach(() => vi.unstubAllGlobals());

describe('landing page (/)', () => {
  it('renders every section without sign-in, even when the API is unreachable', async () => {
    const fetchMock = demoConfig('fail');
    landing();
    for (const name of SECTION_HEADINGS) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    }
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/demo/config'));
    expect(consoleApi.get).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: /See it as a shopper/ })).not.toBeInTheDocument();
  });

  it('every door leads to the right sign-in', () => {
    demoConfig({ demo_mode: false });
    landing();
    const hrefs = (name: RegExp) => screen.getAllByRole('link', { name }).map((a) => a.getAttribute('href'));
    expect(new Set(hrefs(/Brand login/))).toEqual(new Set(['/login?as=brand']));
    expect(new Set(hrefs(/Store login/))).toEqual(new Set(['/login?as=store']));
    expect(screen.getByRole('link', { name: /I'm a brand/ })).toHaveAttribute('href', '/login?as=brand');
    expect(screen.getByRole('link', { name: /I run a store/ })).toHaveAttribute('href', '/login?as=store');
    expect(screen.getByRole('link', { name: 'Qwikspot team sign-in' })).toHaveAttribute('href', '/login?as=platform');
  });

  it('the header links to the sections that exist', () => {
    demoConfig({ demo_mode: false });
    const { container } = landing();
    const nav = screen.getByRole('navigation', { name: 'Sections' });
    for (const link of within(nav).getAllByRole('link')) {
      const id = link.getAttribute('href')!.slice(1);
      expect(container.querySelector(`#${id}`), id).not.toBeNull();
    }
  });

  it('a signed-in visitor sees "Go to your console" instead of the login buttons in the header', () => {
    demoConfig({ demo_mode: false });
    landing({ user: { uid: 'u', email: 'u@test' } });
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('link', { name: /Go to your console/ })).toHaveAttribute('href', '/app');
    expect(within(header).queryByRole('link', { name: 'Brand login' })).not.toBeInTheDocument();
  });

  it("no shopper demo link: shoppers use the brand's real Shopify store", async () => {
    demoConfig({ demo_mode: true, logins: [] });
    landing();
    expect(await screen.findByText('Demo data is synthetic.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /See it as a shopper/ })).not.toBeInTheDocument();
    expect(document.querySelector('a[href="/shop"]')).toBeNull();
  });

  it('illustrations are labelled as examples, and the chat says it comes from the brand', () => {
    demoConfig({ demo_mode: false });
    landing();
    expect(screen.getByText('Example · synthetic data')).toBeInTheDocument();
    expect(screen.getByText('Example')).toBeInTheDocument();
    const visual = screen.getByRole('figure', { name: /Example/ });
    expect(within(visual).getByText('AquaSkin')).toBeInTheDocument();
    expect(within(visual).getByText('Powered by Qwikspot')).toBeInTheDocument();
    // WhatsApp reply buttons are at most 20 characters.
    for (const b of within(visual).getByLabelText('Reply buttons').querySelectorAll('span')) {
      expect(b.textContent!.length).toBeLessThanOrEqual(20);
    }
  });

  it('UI-L2: the hero holds the whole example (AI decision, hold, store) and the previews are labelled', () => {
    demoConfig({ demo_mode: false });
    landing();
    const visual = screen.getByRole('figure', { name: /Example/ });
    expect(within(visual).getByRole('group', { name: 'Example AI decision' })).toHaveTextContent(
      'Safety re-check passed',
    );
    expect(within(visual).getByRole('group', { name: 'Example store queue card' })).toHaveTextContent(
      'Customer •••• 4821',
    );
    expect(within(visual).getByText(/Held for you at/)).toBeInTheDocument();
    expect(screen.getAllByText('Illustrative example')).toHaveLength(3);
    // The moving band repeats itself for the loop; only the first copy is read out.
    const band = screen.getByRole('list', { name: 'What Qwikspot does' });
    expect(
      within(band)
        .getAllByRole('listitem')
        .filter((li) => !li.getAttribute('aria-hidden')),
    ).toHaveLength(8);
  });

  it('on phones the Menu opens a drawer with the sections and both logins', () => {
    demoConfig({ demo_mode: false });
    landing();
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    const drawer = screen.getByRole('dialog', { name: 'Qwikspot' });
    expect(within(drawer).getByRole('link', { name: 'How it works' })).toHaveAttribute('href', '#how-it-works');
    expect(within(drawer).getByRole('link', { name: 'Brand login' })).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: 'Store login' })).toBeInTheDocument();
  });
});
