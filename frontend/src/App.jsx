
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import Navbar from "./Components/navbar.jsx";
import Home from "./pages/Home.jsx";
import ApiTest from "./pages/ApiTest.jsx";
import "./App.css";

function App() {

    return (
        <div className="App">
            <Router>
                <Navbar/>
                <Routes>
                    <Route path="/" element={<Home />} />
                    <Route path="/ApiTest" element={<ApiTest/>} />
                </Routes>
            </Router>
        </div>
    );
}

export default App;
