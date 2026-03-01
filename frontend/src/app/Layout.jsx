import { Outlet } from "react-router-dom";
import Navbar from "../components/common/Navbar.jsx";

function Layout() {
    return (
        <div className="flex flex-col min-h-screen bg-gray-950">
            <Navbar />
            <main className="flex-1">
                <Outlet />
            </main>
        </div>
    );
}

export default Layout;