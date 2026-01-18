import { Outlet } from "react-router-dom";
import Navbar from "../components/common/Navbar.jsx";

function Layout() {
  return (
    <div className="App">
      <Navbar />
      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}

export default Layout;
