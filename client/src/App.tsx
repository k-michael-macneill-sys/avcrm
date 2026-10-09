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
import { CustomerSummary } from '@/routes/CustomerSummary';
import { AddCustomer } from '@/routes/AddCustomer';
import { ContractForm } from '@/routes/ContractForm';
import { AgreementSign } from '@/routes/AgreementSign';
import { ContractLists } from '@/routes/ContractLists';
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
import { Weather } from '@/routes/Weather';
import { WeatherMap } from '@/routes/WeatherMap';
import { Financials } from '@/routes/Financials';
import { Bookkeeping } from '@/routes/Bookkeeping';
import { Projections } from '@/routes/Projections';
import { ColdEmail } from '@/routes/ColdEmail';
import { MetaAds } from '@/routes/MetaAds';
import { CorporateOnly, RoleOnly } from '@/components/CorporateOnly';

const SELLERS: UserRole[] = ['corporate', 'sales', 'branch'];
const CREW: UserRole[] = ['corporate', 'operator', 'branch'];
const BUSINESS: UserRole[] = ['corporate', 'branch'];

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
                <Route path="customers/add" element={<RoleOnly roles={SELLERS} title="Sales only" message="Customers, quotes and contracts are the sales side. Your visits are under Dispatch."><AddCustomer /></RoleOnly>} />
                <Route path="customers/:id" element={<RoleOnly roles={SELLERS} title="Sales only" message="Customers, quotes and contracts are the sales side. Your visits are under Dispatch."><CustomerSummary /></RoleOnly>} />
                <Route path="customers/:id/contracts/new" element={<RoleOnly roles={SELLERS} title="Sales only" message="Customers, quotes and contracts are the sales side. Your visits are under Dispatch."><ContractForm /></RoleOnly>} />
                <Route path="agreements/:quoteId" element={<RoleOnly roles={SELLERS} title="Sales only" message="Customers, quotes and contracts are the sales side. Your visits are under Dispatch."><AgreementSign /></RoleOnly>} />
                <Route path="agreements/:quoteId/edit" element={<RoleOnly roles={SELLERS} title="Sales only" message="Customers, quotes and contracts are the sales side. Your visits are under Dispatch."><ContractForm /></RoleOnly>} />

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
                  path="settings/lists"
                  element={
                    <CorporateOnly message="The contract form's lists are kept by the office.">
                      <ContractLists />
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

                {/* Everyone signed in: each sees only their own branch's customers on it. */}
                <Route path="snow-map" element={<WeatherMap />} />

                <Route
                  path="weather"
                  element={
                    <CorporateOnly message="The weather bot is run from the office.">
                      <Weather />
                    </CorporateOnly>
                  }
                />

                {/* The Business Console: corporate's for the company, each branch's for itself. */}
                <Route path="business">
                  <Route
                    index
                    element={
                      <RoleOnly roles={BUSINESS} title="Business Console" message="The Business Console belongs to corporate and each branch's own sign-in.">
                        <Financials />
                      </RoleOnly>
                    }
                  />
                  <Route
                    path="projections"
                    element={
                      <RoleOnly roles={BUSINESS} title="Business Console" message="The Business Console belongs to corporate and each branch's own sign-in.">
                        <Projections />
                      </RoleOnly>
                    }
                  />
                  <Route
                    path="bookkeeping"
                    element={
                      <RoleOnly roles={BUSINESS} title="Business Console" message="The Business Console belongs to corporate and each branch's own sign-in.">
                        <Bookkeeping />
                      </RoleOnly>
                    }
                  />
                  <Route
                    path="cold-email"
                    element={
                      <RoleOnly roles={BUSINESS} title="Business Console" message="The Business Console belongs to corporate and each branch's own sign-in.">
                        <ColdEmail />
                      </RoleOnly>
                    }
                  />
                  <Route
                    path="meta-ads"
                    element={
                      <RoleOnly roles={BUSINESS} title="Business Console" message="The Business Console belongs to corporate and each branch's own sign-in.">
                        <MetaAds />
                      </RoleOnly>
                    }
                  />
                </Route>

                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Route>
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  );
}
