import { Link } from "react-router-dom";
import "../../styles/navbar.css";

function Navbar() {
  return (
    <nav className="navbar">
      <h2 className="logo">Brain Atlas</h2>

      <ul className="nav-links">
        <li><Link to="/">Home</Link></li>
        <li><Link to="/atlas">Atlas</Link></li>
        <li><Link to="/atlas-2d">2D Atlas (MVP)</Link></li>
        <li><Link to="/data">Query Data</Link></li>
        <li><Link to="/ai-prompt">AI Prompt</Link></li>
        <li><Link to="/2D-brain">2D Brain</Link></li>
      </ul>
    </nav>
  );
}

export default Navbar;
