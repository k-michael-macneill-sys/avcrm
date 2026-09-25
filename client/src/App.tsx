import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '@/auth/AuthContext';
import { RequireAuth } from '@/auth/RequireAuth';
import { Shell } from '@/components/Shell';
import { ThemeProvider } from '@/theme/ThemeProvider';
import type { UserRole } from '../../src/types/models';
import { Login } from '@/routes/Login';
import { Dashboard } from '@/routes/Dashboard';
import { Reports } from '@/routes/Reports';
import { Customers } from '@/routes/Customers';
import { CustomerDetail } from '@/routes/CustomerDetail';
import { NewCustomer } from '@/routes/NewCustomer';
import { Sign } from '@/routes/Sign';
import { Leads } from '@/routes/Leads';
import { Quotes } from '@/routes/Quotes';
import { QuoteDetail } from '@/routes/QuoteDetail';
import { Contracts } from '@/routes/Contracts';
import { ContractDetail } from '@/routes/ContractDetail';
import { WorkOrders } from '@/routes/WorkOrders';
import { WorkOrderDetail } from '@/routes/WorkOrderDetail';
import { Invoices } from '@/routes/Invoices';
import { InvoiceDetail } from '@/routes/InvoiceDetail';
import { Operators } from '@/routes/Operators';
import { OperatorDetail } from '@/routes/OperatorDetail';
import { Admin } from '@/routes/Admin';
import { Settings } from '@/routes/Settings';
import { CorporateOnly, RoleOnly } from '@/components/CorporateOnly';

const SELLERS: UserRole[] = ['corporate', 'sales'];
const CREW: UserRole[] = ['corporate', 'operator'];

export default function App(): JSX.Element {
  return (
    <ThemeProvider>
      <BrowserRouter basename="/app">
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<Login />} />
            {/* The customer's own page from an emailed agreement: no login. */}
            <Route path="/sign/:token" element={<Sign />} />
            <Route element={<RequireAuth />}>
              <Route element={<Shell />}>
                <Route index element={<Dashboard />} />
                <Route
                  path="leads"
                  element={
                    <RoleOnly roles={SELLERS} title="Sales only" message="The door-knocking map is for sales reps and the office.">
                      <Leads />
                    </RoleOnly>
                  }
                />

                <Route path="customers" element={<RoleOnly roles={SELLERS} title="Sales only" message="Customers, quotes and contracts are the sales side. Your visits are under Dispatch."><Customers /></RoleOnly>} />
                <Route path="customers/new" element={<RoleOnly roles={SELLERS} title="Sales only" message="Customers, quotes and contracts are the sales side. Your visits are under Dispatch."><NewCustomer /></RoleOnly>} />
                <Route path="customers/:id" element={<RoleOnly roles={SELLERS} title="Sales only" message="Customers, quotes and contracts are the sales side. Your visits are under Dispatch."><CustomerDetail /></RoleOnly>} />

                <Route path="quotes" element={<RoleOnly roles={SELLERS} title="Sales only" message="Customers, quotes and contracts are the sales side. Your visits are under Dispatch."><Quotes /></RoleOnly>} />
                <Route path="quotes/:id" element={<RoleOnly roles={SELLERS} title="Sales only" message="Customers, quotes and contracts are the sales side. Your visits are under Dispatch."><QuoteDetail /></RoleOnly>} />

                <Route path="contracts" element={<RoleOnly roles={SELLERS} title="Sales only" message="Customers, quotes and contracts are the sales side. Your visits are under Dispatch."><Contracts /></RoleOnly>} />
                <Route path="contracts/:id" element={<RoleOnly roles={SELLERS} title="Sales only" message="Customers, quotes and contracts are the sales side. Your visits are under Dispatch."><ContractDetail /></RoleOnly>} />

                <Route path="work-orders" element={<RoleOnly roles={CREW} title="Crew only" message="Visits and crew paperwork belong to operators and the office. Your customers are under Customers."><WorkOrders /></RoleOnly>} />
                <Route path="work-orders/:id" element={<RoleOnly roles={CREW} title="Crew only" message="Visits and crew paperwork belong to operators and the office. Your customers are under Customers."><WorkOrderDetail /></RoleOnly>} />

                <Route
                  path="invoices"
                  element={
                    <CorporateOnly message="Billing is corporate work. Your own visits are under Dispatch.">
                      <Invoices />
                    </CorporateOnly>
                  }
                />
                <Route
                  path="invoices/:id"
                  element={
                    <CorporateOnly message="Billing is corporate work. Your own visits are under Dispatch.">
                      <InvoiceDetail />
                    </CorporateOnly>
                  }
                />

                <Route path="operators" element={<RoleOnly roles={CREW} title="Crew only" message="Visits and crew paperwork belong to operators and the office. Your customers are under Customers."><Operators /></RoleOnly>} />
                <Route path="operators/:id" element={<RoleOnly roles={CREW} title="Crew only" message="Visits and crew paperwork belong to operators and the office. Your customers are under Customers."><OperatorDetail /></RoleOnly>} />

                <Route
                  path="reports"
                  element={
                    <CorporateOnly message="Roll-up reporting is corporate work. Your own visits are under Dispatch.">
                      <Reports />
                    </CorporateOnly>
                  }
                />
                <Route
                  path="admin"
                  element={
                    <CorporateOnly message="Adding branches and staff is corporate work.">
                      <Admin />
                    </CorporateOnly>
                  }
                />
                <Route
                  path="settings"
                  element={
                    <CorporateOnly message="Connecting outside services is corporate work.">
                      <Settings />
                    </CorporateOnly>
                  }
                />

                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Route>
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  );
}
