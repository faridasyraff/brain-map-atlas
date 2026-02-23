import { useState } from "react";
import { Link } from "react-router-dom";
import "../../styles/navbar.css";

function Navbar() {
    const [isOpen, setIsOpen] = useState(false);

    return (
        <nav className="navbar">
            <h2 className="logo">Brain Atlas</h2>

            <button
                className={`hamburger ${isOpen ? "open" : ""}`}
                onClick={() => setIsOpen(!isOpen)}
                aria-label="Toggle navigation"
            >
                <span />
                <span />
                <span />
            </button>

            <ul className={`nav-links ${isOpen ? "open" : ""}`}>
                <li><Link to="/" onClick={() => setIsOpen(false)}>Home</Link></li>
                <li><Link to="/atlas" onClick={() => setIsOpen(false)}>Atlas</Link></li>
                <li><Link to="/atlas-2d" onClick={() => setIsOpen(false)}>2D Atlas (MVP)</Link></li>
                <li><Link to="/data" onClick={() => setIsOpen(false)}>Query Data</Link></li>
                <li><Link to="/ai-prompt" onClick={() => setIsOpen(false)}>AI Prompt</Link></li>
                <li><Link to="/2D-brain" onClick={() => setIsOpen(false)}>2D Brain</Link></li>
            </ul>
        </nav>
    );
}

export default Navbar;