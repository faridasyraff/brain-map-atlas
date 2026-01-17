
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import Navbar from "./Components/navbar";
import Home from "./pages/Home";
import ApiTest from "./pages/ApiTest";
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
