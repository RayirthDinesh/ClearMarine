import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import ReportDebris from './pages/ReportDebris';
import Dashboard from './pages/Dashboard';
import VesselStation from './pages/VesselStation';
import ShoreStation from './pages/ShoreStation';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/report" replace />} />
        <Route path="/report" element={<ReportDebris />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/vessel/:vesselId" element={<VesselStation />} />
        <Route path="/shore/:landCrewId" element={<ShoreStation />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
