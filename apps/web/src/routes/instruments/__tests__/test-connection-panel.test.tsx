import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ModbusRegisterMap } from '@digilog/shared';

/**
 * Test connection (TCP/IP instruments spec §8): read the device once with the
 * form's own address, Slave ID (CR-1) and map and show what came back — every key's value, or
 * the failure in the SERVER's words. The browser decides nothing: the sentence
 * is printed verbatim, the code only picks the pill, and which key is judged is
 * the response's `judgedAs`, handed up through `onJudged`.
 */

const post = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: { post: (...a: unknown[]) => post(...a), get: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const { TestConnectionPanel } = await import('../test-connection-panel');

const MAP: ModbusRegisterMap = [
  { key: 'Temperature', register: '40001', dataType: 'FLOAT32', byteOrder: 'ABCD', scale: 1 },
  { key: 'Humidity', register: '40003', dataType: 'FLOAT32', byteOrder: 'DCBA', scale: 1 },
  { key: 'Pressure', register: '40005', dataType: 'FLOAT32', byteOrder: 'BADC', scale: 1 },
  { key: 'Power', register: '40007', dataType: 'FLOAT32', byteOrder: 'CDAB', scale: 1 },
];
const OK = {
  ok: true, elapsedMs: 42, requests: 1,
  values: [
    { key: 'Temperature', value: 22.4, judgedAs: 'TEMPERATURE' },
    { key: 'Humidity', value: 47.1, judgedAs: 'HUMIDITY' },
    { key: 'Pressure', value: 101.7, judgedAs: null },
  ],
  rejected: [{ key: 'Power', reason: 'Power decoded to NaN from 7FC0 0000' }],
};
const READING_OFF = { ok: false, code: 'READING_OFF', message: 'Reading devices from this server is off (Configuration → TCP/IP Reading).' };
const IN_USE = { ok: false, code: 'ADDRESS_IN_USE', message: '192.168.1.24 : 502 is already used by instrument "CWH/RDU/101-01".' };
const NO_ANSWER = { ok: false, code: 'NO_ANSWER', message: '192.168.1.24 : 502 did not answer within 3 s — check the IP, the cable, and that the device is on.' };

const onJudged = vi.fn();
const renderPanel = (over: Partial<{ host: string; port: number; unitId: number; map: ModbusRegisterMap; instrumentId: string }> = {}) =>
  render(
    <TestConnectionPanel
      profileId="t-1"
      host={over.host ?? '192.168.1.24'}
      port={over.port ?? 502}
      unitId={over.unitId ?? 7}
      map={over.map ?? MAP}
      instrumentId={over.instrumentId}
      onJudged={onJudged}
    />,
  );
const runTest = () => fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

beforeEach(() => {
  post.mockReset();
  onJudged.mockReset();
});

describe('TestConnectionPanel — the request', () => {
  it('sends the form\'s profile, address, Slave ID and map — nothing else for a new instrument', async () => {
    post.mockResolvedValue(OK);
    renderPanel();
    runTest();
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/instruments/modbus/test', {
      profileId: 't-1', modbusHost: '192.168.1.24', modbusPort: 502, modbusUnitId: 7, modbusRegisters: MAP,
    }));
  });

  it('the Slave ID reaches the request as typed — 0 is a real unit id', async () => {
    post.mockResolvedValue(OK);
    renderPanel({ unitId: 0 });
    runTest();
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/instruments/modbus/test', expect.objectContaining({ modbusUnitId: 0 })));
  });

  it('names the stored instrument when it has one (its own address is not "in use")', async () => {
    post.mockResolvedValue(OK);
    renderPanel({ instrumentId: 'i-9' });
    runTest();
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/instruments/modbus/test', expect.objectContaining({ instrumentId: 'i-9' })));
  });

  it('cannot test without an address and at least one key', () => {
    renderPanel({ map: [] });
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();
    expect(screen.getByText('Add at least one key to test.')).toBeInTheDocument();
  });

  it('cannot test without a whole-number Slave ID from 0 to 255, and says so', () => {
    for (const unitId of [Number.NaN, 256, -1, 1.5]) {
      const { unmount } = renderPanel({ unitId });
      expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();
      expect(screen.getByText('Set a Slave ID from 0 to 255 to test.')).toBeInTheDocument();
      unmount();
    }
  });

  it('cannot test a map the shared schema refuses (a row whose data type was cleared)', () => {
    renderPanel({ map: [{ ...MAP[0]!, dataType: '' as never }] });
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();
    expect(screen.getByText('Fix the marked register map rows to test.')).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });
});

describe('TestConnectionPanel — a device that answered', () => {
  it('shows every key\'s value, and a key that could not be read with its reason', async () => {
    post.mockResolvedValue(OK);
    renderPanel();
    runTest();
    expect(await screen.findByText(/Connected in 42 ms/)).toBeInTheDocument();
    expect(screen.getByTestId('test-value-Temperature')).toHaveTextContent('22.4');
    expect(screen.getByTestId('test-value-Pressure')).toHaveTextContent('101.7');
    expect(screen.getByTestId('test-value-Power')).toHaveTextContent('Not readable');
    expect(screen.getByTestId('test-value-Power')).toHaveTextContent('Power decoded to NaN from 7FC0 0000');
  });

  it('hands up the judgement the response made, and only that', async () => {
    post.mockResolvedValue(OK);
    renderPanel();
    runTest();
    await waitFor(() => expect(onJudged).toHaveBeenLastCalledWith({ Temperature: 'TEMPERATURE', Humidity: 'HUMIDITY', Pressure: null }));
  });

  it('drops the result, and the judgement, when the map changes after the test', async () => {
    post.mockResolvedValue(OK);
    const { rerender } = renderPanel();
    runTest();
    await screen.findByText(/Connected in 42 ms/);
    rerender(
      <TestConnectionPanel profileId="t-1" host="192.168.1.24" port={502} unitId={7} map={MAP.slice(0, 2)} onJudged={onJudged} />,
    );
    expect(screen.queryByText(/Connected in 42 ms/)).not.toBeInTheDocument();
    expect(onJudged).toHaveBeenLastCalledWith({});
  });

  it('drops the result when the Slave ID changes after the test', async () => {
    post.mockResolvedValue(OK);
    const { rerender } = renderPanel();
    runTest();
    await screen.findByText(/Connected in 42 ms/);
    rerender(
      <TestConnectionPanel profileId="t-1" host="192.168.1.24" port={502} unitId={8} map={MAP} onJudged={onJudged} />,
    );
    expect(screen.queryByText(/Connected in 42 ms/)).not.toBeInTheDocument();
    expect(onJudged).toHaveBeenLastCalledWith({});
  });
});

describe('TestConnectionPanel — a failure is said in the server\'s words', () => {
  it('READING_OFF', async () => {
    post.mockResolvedValue(READING_OFF);
    renderPanel();
    runTest();
    expect(await screen.findByText(READING_OFF.message)).toBeInTheDocument();
    expect(screen.getByTestId('test-pill')).toHaveTextContent('Reading off');
    expect(onJudged).toHaveBeenLastCalledWith({});
  });

  it('ADDRESS_IN_USE', async () => {
    post.mockResolvedValue(IN_USE);
    renderPanel();
    runTest();
    expect(await screen.findByText(IN_USE.message)).toBeInTheDocument();
    expect(screen.getByTestId('test-pill')).toHaveTextContent('In use');
  });

  it('NO_ANSWER', async () => {
    post.mockResolvedValue(NO_ANSWER);
    renderPanel();
    runTest();
    expect(await screen.findByText(NO_ANSWER.message)).toBeInTheDocument();
    expect(screen.getByTestId('test-pill')).toHaveTextContent('No answer');
  });

  it('a refused request (400 ADDRESS_NOT_ALLOWED) is printed in the panel, not lost', async () => {
    const err = Object.assign(new Error('192.168.1.24 is outside the device networks this server may read (10.0.0.0/8) — Configuration → TCP/IP Reading.'), { status: 400, code: 'ADDRESS_NOT_ALLOWED' });
    post.mockRejectedValue(err);
    renderPanel();
    runTest();
    expect(await screen.findByText(err.message)).toBeInTheDocument();
    expect(screen.getByTestId('test-pill')).toHaveTextContent('Not allowed');
  });

  it('a 429 (30 tests a minute) has its own pill and prints the rate-limit plugin\'s own sentence', async () => {
    post.mockRejectedValue(Object.assign(new Error('Rate limit exceeded, retry in 59 seconds'), { status: 429, code: 'TOO_MANY_REQUESTS' }));
    renderPanel();
    runTest();
    expect(await screen.findByText('Rate limit exceeded, retry in 59 seconds')).toBeInTheDocument();
    expect(screen.getByTestId('test-pill')).toHaveTextContent('Too many tests');
  });

  it('a code it does not know still prints the message', async () => {
    post.mockRejectedValue(Object.assign(new Error('You do not have permission to test this connection.'), { status: 403, code: 'FORBIDDEN' }));
    renderPanel();
    runTest();
    expect(await screen.findByText('You do not have permission to test this connection.')).toBeInTheDocument();
    expect(screen.getByTestId('test-pill')).toHaveTextContent('Not tested');
  });
});
