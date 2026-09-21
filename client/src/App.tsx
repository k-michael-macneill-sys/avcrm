import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '@/auth/AuthContext';
import { RequireAuth } from '@/auth/RequireAuth';
import { Shell } from '@/components/Shell';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { Login } from '@/routes/Login';
import { Dashboard } from '@/routes/Dashboard';
import { Reports } from '@/routes/Reports';
import { Customers } from '@/routes/Customers';
import { CustomerDetail } from '@/routes/CustomerDetail';
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
import { CorporateOnly } from '@/components/CorporateOnly';

export default function App(): JSX.Element {
  return (
    <ThemeProvider>
      <BrowserRouter basename="/app">
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route element={<RequireAuth />}>
              <Route element={<Shell />}>
                <Route index element={<Dashboard />} />

                <Route path="customers" element={<Customers />} />
                <Route path="customers/:id" element={<CustomerDetail />} />

                <Route path="quotes" element={<Quotes />} />
                <Route path="quotes/:id" element={<QuoteDetail />} />

                <Route path="contracts" element={<Contracts />} />
                <Route path="contracts/:id" element={<ContractDetail />} />

                <Route path="work-orders" element={<WorkOrders />} />
                <Route path="work-orders/:id" element={<WorkOrderDetail />} />

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

                <Route path="operators" element={<Operators />} />
                <Route path="operators/:id" element={<OperatorDetail />} />

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
