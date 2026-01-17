import { Link } from "react-router-dom";
import "./Navbar.css";

function Navbar() {
    return (
        <nav className="navbar">
            <h2 className="logo">Brain Atlas</h2>

            <ul className="nav-links">
                <li><Link to="/">Home</Link></li>
                <li><Link to="/ApiTest">API TEST</Link></li>
            </ul>
        </nav>
    );
}

export default Navbar;
