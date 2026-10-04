import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  Button,
  ConfirmDialog,
  Drawer,
  EmptyState,
  ErrorState,
  KpiTile,
  ProductThumb,
  Skeleton,
  StatusPill,
  Table,
  Tabs,
  Timeline,
  ToastProvider,
  useToast,
} from '../components/ui';

/** UI-0 component library: behaviour and accessibility, not looks. */

describe('Button', () => {
  it('defaults to type="button"; loading disables it and marks it busy', () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toHaveAttribute('type', 'button');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(
      <Button onClick={onClick} loading>
        Save
      </Button>,
    );
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('StatusPill and KpiTile', () => {
  it('statuses read as words with a meaning-based tone', () => {
    render(
      <>
        <StatusPill status="CUSTOMER_ARRIVED" />
        <StatusPill status="SUSPENDED" />
      </>,
    );
    expect(screen.getByText('Customer arrived')).toHaveClass('ui-pill--info');
    expect(screen.getByText('Suspended')).toHaveClass('ui-pill--danger');
  });

  it('marks estimated and synthetic numbers', () => {
    render(<KpiTile label="Store sales" value="₹24,650" estimated synthetic />);
    expect(screen.getByText('est.')).toBeInTheDocument();
    expect(screen.getByText('Includes synthetic history')).toBeInTheDocument();
  });
});

describe('Tabs', () => {
  function Harness() {
    const [value, setValue] = useState('a');
    return (
      <Tabs
        label="Views"
        value={value}
        onChange={setValue}
        items={[
          { id: 'a', label: 'Active', count: 2 },
          { id: 'b', label: 'History' },
          { id: 'c', label: 'Stock' },
        ]}
      />
    );
  }
  it('is an ARIA tablist; arrows, Home and End move and select', () => {
    render(<Harness />);
    const list = screen.getByRole('tablist', { name: 'Views' });
    const tabs = within(list).getAllByRole('tab');
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[1]).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' });
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(tabs[1]);
    fireEvent.keyDown(tabs[1]!, { key: 'End' });
    expect(tabs[2]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tabs[2]!, { key: 'ArrowRight' });
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowLeft' });
    expect(tabs[2]).toHaveAttribute('aria-selected', 'true');
  });
});

describe('Table', () => {
  it('rows open with a click or Enter when clickable', () => {
    const onRowClick = vi.fn();
    render(
      <Table
        caption="Holds"
        rows={[{ id: '1', name: 'Serum' }]}
        rowKey={(r) => r.id}
        onRowClick={onRowClick}
        columns={[{ key: 'n', header: 'Product', render: (r) => r.name }]}
      />,
    );
    const row = screen.getByText('Serum').closest('tr')!;
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onRowClick).toHaveBeenCalledTimes(2);
    expect(row).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('columnheader', { name: 'Product' })).toHaveAttribute('scope', 'col');
  });
});

describe('states', () => {
  it('empty state has a sentence and an action; error state retries and shows the reference; skeleton announces loading', () => {
    const onRetry = vi.fn();
    render(
      <>
        <EmptyState action={<Button>Import</Button>}>No stock yet.</EmptyState>
        <ErrorState message="Database unavailable." reference="req_1" onRetry={onRetry} />
        <Skeleton label="Loading holds" />
      </>,
    );
    expect(screen.getByText('No stock yet.')).toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Database unavailable.');
    expect(alert).toHaveTextContent('Reference: req_1');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Loading holds…');
  });
});

describe('ConfirmDialog and Drawer', () => {
  it('the dialog focuses its first action, confirms, and closes on Escape', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog open title="Reset the demo?" confirmLabel="Reset" onConfirm={onConfirm} onCancel={onCancel}>
        Everyone's session is cleared.
      </ConfirmDialog>,
    );
    const dialog = screen.getByRole('alertdialog', { name: 'Reset the demo?' });
    expect(dialog).toHaveAccessibleDescription("Everyone's session is cleared.");
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset' }));
    expect(onConfirm).toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
  });

  it('Tab wraps inside the dialog', () => {
    render(
      <ConfirmDialog open title="T" confirmLabel="OK" onConfirm={vi.fn()} onCancel={vi.fn()}>
        body
      </ConfirmDialog>,
    );
    const ok = screen.getByRole('button', { name: 'OK' });
    ok.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('the drawer is a labelled dialog that closes', () => {
    const onClose = vi.fn();
    render(
      <Drawer open title="Demo controls" onClose={onClose}>
        tools
      </Drawer>,
    );
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Demo controls' })).getByRole('button', { name: 'Close' }),
    );
    expect(onClose).toHaveBeenCalled();
  });
});

describe('Toast', () => {
  it('announces in a polite live region and disappears after its duration', () => {
    vi.useFakeTimers();
    function Fire() {
      const toast = useToast();
      return <button onClick={() => toast.show('Reservation confirmed.')}>go</button>;
    }
    render(
      <ToastProvider duration={1000}>
        <Fire />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    const region = screen.getByLabelText('Notifications');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('Reservation confirmed.');
    act(() => vi.advanceTimersByTime(1100));
    expect(region).not.toHaveTextContent('Reservation confirmed.');
    vi.useRealTimers();
  });
});

describe('Timeline and ProductThumb', () => {
  it('timeline is an ordered, labelled list', () => {
    render(
      <Timeline
        label="Journey"
        items={[
          { id: '1', title: 'Viewed', time: '6:40 pm' },
          { id: '2', title: 'Held', time: '6:42 pm' },
        ]}
      />,
    );
    const list = screen.getByRole('list', { name: 'Journey' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Viewed6:40 pm', 'Held6:42 pm']);
  });

  it('a product without an image shows its initials', () => {
    render(<ProductThumb name="Vitamin C Glow Serum" />);
    expect(screen.getByRole('img', { name: 'Vitamin C Glow Serum' })).toHaveTextContent('VC');
  });
});
