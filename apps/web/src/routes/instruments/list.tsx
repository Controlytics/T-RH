import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import useSWR from 'swr';
import { TRANSPORTS } from '@digilog/shared';
import { useCan } from '@/hooks/use-can';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { usePaginationConfig } from '@/hooks/use-pagination-config';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Pagination } from '@/components/ui/pagination';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';

interface InstrumentRow {
  id: string;
  name: string;
  code: string;
  transport: string;
  isActive: boolean;
  tokenPrefix: string | null;
  lastSeenAt: string | null;
  lastSeenVia: string | null;
  isGateway: boolean;
  block: string | null;
  area: string | null;
  location: string | null;
}
interface ListResponse {
  data: InstrumentRow[];
  total: number; page: number; limit: number; totalPages: number;
}

export function InstrumentListPage() {
  const can = useCan();
  const { formatDate, formatTime } = useDatetimeFormat();
  const paginationOptions = usePaginationConfig();

  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(paginationOptions[0]);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [transport, setTransport] = useState('');
  const [active, setActive] = useState('');
  const [block, setBlock] = useState('');
  const [debouncedBlock, setDebouncedBlock] = useState('');
  const [area, setArea] = useState('');
  const [debouncedArea, setDebouncedArea] = useState('');
  const [location, setLocation] = useState('');
  const [debouncedLocation, setDebouncedLocation] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const placementDebounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    debounceRef.current = setTimeout(() => { setDebouncedSearch(search); setPage(1); }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [search]);

  useEffect(() => {
    placementDebounceRef.current = setTimeout(() => {
      setDebouncedBlock(block); setDebouncedArea(area); setDebouncedLocation(location);
      setPage(1);
    }, 300);
    return () => clearTimeout(placementDebounceRef.current);
  }, [block, area, location]);

  const params = new URLSearchParams({ page: String(page), limit: String(perPage) });
  if (debouncedSearch) params.set('search', debouncedSearch);
  if (transport) params.set('transport', transport);
  if (active) params.set('isActive', active);
  if (debouncedBlock) params.set('block', debouncedBlock);
  if (debouncedArea) params.set('area', debouncedArea);
  if (debouncedLocation) params.set('location', debouncedLocation);

  const { data, isLoading } = useSWR<ListResponse>(`/api/instruments?${params}`);
  const rows = data?.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Instruments</h1>
          <p className="text-sm text-slate-500">
            Devices registered to send telemetry to this system.
          </p>
        </div>
        {can('instruments.create') && (
          <div className="flex gap-2">
            <Link to="/instruments/bulk"><Button variant="secondary">Bulk Upload</Button></Link>
            <Link to="/instruments/new"><Button>New Instrument</Button></Link>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-3">
        <Input
          className="w-64"
          placeholder="Search name, code or serial…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select
          className="w-44"
          value={transport}
          onChange={(e) => { setTransport(e.target.value); setPage(1); }}
        >
          <option value="">All transports</option>
          {TRANSPORTS.map((t) => <option key={t} value={t}>{t}</option>)}
        </Select>
        <Select
          className="w-40"
          value={active}
          onChange={(e) => { setActive(e.target.value); setPage(1); }}
        >
          <option value="">All statuses</option>
          <option value="true">Active</option>
          <option value="false">Inactive</option>
        </Select>
        <Input className="w-36" placeholder="Block" value={block} onChange={(e) => setBlock(e.target.value)} />
        <Input className="w-36" placeholder="Area" value={area} onChange={(e) => setArea(e.target.value)} />
        <Input className="w-36" placeholder="Location" value={location} onChange={(e) => setLocation(e.target.value)} />
      </div>

      <div className="rounded-xl border border-slate-200 bg-white">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Code</TableHead>
              <TableHead>Transport</TableHead>
              <TableHead>Status</TableHead>
              {/* The at-a-glance answer to "is this device actually talking?" */}
              <TableHead>Last seen</TableHead>
              <TableHead>Token</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow><TableCell colSpan={7} className="py-8 text-center text-slate-400">Loading…</TableCell></TableRow>
            )}
            {!isLoading && rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-slate-500">
                  No instruments yet.
                  {can('instruments.create') && <> <Link to="/instruments/new" className="text-blue-600 hover:underline">Register the first one</Link>.</>}
                </TableCell>
              </TableRow>
            )}
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-medium text-slate-900">
                  <span className="flex items-center gap-2">
                    {r.name}
                    {r.isGateway && <Badge variant="outline">Gateway</Badge>}
                  </span>
                </TableCell>
                <TableCell className="font-mono text-xs">{r.code}</TableCell>
                <TableCell><Badge variant="secondary">{r.transport}</Badge></TableCell>
                <TableCell>
                  <Badge variant={r.isActive ? 'success' : 'secondary'}>
                    {r.isActive ? 'Active' : 'Inactive'}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-slate-600">
                  {r.lastSeenAt
                    ? (
                        <>
                          {formatDate(r.lastSeenAt)} {formatTime(r.lastSeenAt)}
                          {r.lastSeenVia === 'gateway' && (
                            <span className="ml-1 text-xs text-slate-400">(via gateway)</span>
                          )}
                        </>
                      )
                    : <span className="text-slate-400">Never</span>}
                </TableCell>
                <TableCell className="font-mono text-xs text-slate-500">
                  {r.tokenPrefix ? `${r.tokenPrefix}…` : '—'}
                </TableCell>
                <TableCell className="text-right">
                  <Link to={`/instruments/${r.id}`} className="text-sm text-blue-600 hover:underline">View</Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Pagination
        page={page}
        pageSize={perPage}
        totalItems={data?.total ?? 0}
        onPageChange={setPage}
        onPageSizeChange={(n) => { setPerPage(n); setPage(1); }}
        pageSizeOptions={paginationOptions}
      />
    </div>
  );
}
