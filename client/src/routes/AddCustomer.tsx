import * as React from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { Branch, Customer, Property } from '../../../src/types/models';
import { PHONE_TYPES, type PhoneType } from '../../../src/types/serviceAgreement';
import { useAuth } from '@/auth/AuthContext';
import { ErrorNotice, Loading } from '@/components/Misc';
import { PageHeader } from '@/components/PageHeader';
import { Section } from '@/components/Section';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { PHONE_TYPE_LABELS } from '@/lib/agreements';
import * as api from '@/lib/api';
import { useQuery } from '@/lib/useQuery';
import { useSubmit } from '@/lib/useSubmit';

/**
 * A new customer: who they are and where we clear, and then straight on to
 * the contract form. Takes the same address prefill as the door sign-up
 * (?address_line1=&city=&province=&postal_code=&lat=&lng=).
 */
export function AddCustomer(): JSX.Element {
  const { isCorporate, isBranch, branch: myBranch } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const branches = useQuery(() => api.get<Branch[]>('/branches'), []);
  const [v, setV] = React.useState({
    branch_id: '',
    first_name: '',
    last_name: '',
    email: '',
    phone: '',
    phone_type: 'mobile' as PhoneType,
    address_line1: params.get('address_line1') ?? '',
    city: params.get('city') ?? '',
    province: params.get('province') ?? '',
    postal_code: params.get('postal_code') ?? '',
    access_notes: '',
  });
  const set = (key: keyof typeof v, value: string) => setV((s) => ({ ...s, [key]: value }));
  const { run, pending, error } = useSubmit();

  const list = branches.data ?? [];
  const branchId = v.branch_id || myBranch?.id || (list.length === 1 ? list[0]!.id : '');
  const branch = list.find((b) => b.id === branchId);
  const branchCity = isBranch ? (myBranch?.default_city ?? null) : null;

  if (branches.loading) return <Loading />;

  const save = () =>
    run(async () => {
      const email = v.email.trim() || null;
      const phone = v.phone.trim() || null;
      const customer = await api.post<Customer>('/customers', {
        ...(isCorporate ? { branch_id: branchId } : {}),
        first_name: v.first_name,
        last_name: v.last_name,
        email,
        phone,
        preferred_contact: email && phone ? 'both' : email ? 'email' : 'sms',
        status: 'lead',
      });
      if (phone && v.phone_type !== 'mobile') {
        await api.put(`/customers/${customer.id}/phones`, {
          phones: [{ number: phone, phone_type: v.phone_type, is_primary: true }],
        });
      }
      const lat = Number(params.get('lat'));
      const lng = Number(params.get('lng'));
      await api.post<Property>('/properties', {
        customer_id: customer.id,
        address_line1: v.address_line1,
        ...(branchCity ? {} : { city: v.city }),
        province: v.province || branch?.province || '',
        postal_code: v.postal_code,
        access_notes: v.access_notes.trim() || null,
        ...(params.get('lat') && Number.isFinite(lat) && Number.isFinite(lng) ? { latitude: lat, longitude: lng } : {}),
      });
      navigate(`/customers/${customer.id}/contracts/new`);
    });

  const text = (key: keyof typeof v, label: string, type = 'text') => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`add-${key}`}>{label}</Label>
      <Input id={`add-${key}`} type={type} value={v[key]} onChange={(e) => set(key, e.target.value)} />
    </div>
  );

  return (
    <>
      <PageHeader
        title="Add customer"
        subtitle="Their details and service address. The contract comes next."
        actions={
          <Button asChild variant="secondary">
            <Link to="/customers/new">Door sign-up (PDF agreement)</Link>
          </Button>
        }
      />
      <div className="flex max-w-3xl flex-col gap-4">
        {isCorporate && list.length > 1 ? (
          <Section title="Branch">
            <Select value={branchId} onValueChange={(id) => set('branch_id', id)}>
              <SelectTrigger aria-label="Branch" className="max-w-xs">
                <SelectValue placeholder="Choose a branch" />
              </SelectTrigger>
              <SelectContent>
                {list.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Section>
        ) : null}
        <Section title="Customer">
          <div className="grid gap-3 sm:grid-cols-2">
            {text('first_name', 'First name')}
            {text('last_name', 'Last name')}
            {text('email', 'Email', 'email')}
            <div className="flex gap-2">
              <div className="flex-1">{text('phone', 'Phone', 'tel')}</div>
              <div className="flex flex-col gap-1.5">
                <Label>Type</Label>
                <Select value={v.phone_type} onValueChange={(t) => set('phone_type', t)}>
                  <SelectTrigger className="w-28" aria-label="Phone type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PHONE_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {PHONE_TYPE_LABELS[t]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </Section>
        <Section title="Service address">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">{text('address_line1', 'Street address')}</div>
            {branchCity ? null : text('city', 'City / town')}
            {text('province', `Province${branch ? ` (default ${branch.province})` : ''}`)}
            {text('postal_code', 'Postal code')}
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="add-notes">Notes for the crew</Label>
              <Textarea
                id="add-notes"
                rows={3}
                value={v.access_notes}
                placeholder="Gate code, where to pile snow, the dog in the yard…"
                onChange={(e) => set('access_notes', e.target.value)}
              />
            </div>
          </div>
        </Section>
        {error ? <ErrorNotice message={error} /> : null}
        <div className="flex justify-end gap-2 pb-6">
          <Button asChild variant="secondary">
            <Link to="/customers">Cancel</Link>
          </Button>
          <Button
            type="button"
            disabled={pending || !v.first_name.trim() || !v.last_name.trim() || (!v.email.trim() && !v.phone.trim()) || !v.address_line1.trim() || (isCorporate && !branchId)}
            onClick={save}
          >
            {pending ? 'Saving…' : 'Save and create contract'}
          </Button>
        </div>
      </div>
    </>
  );
}
