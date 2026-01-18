import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import Layout from "./Layout.jsx";
import Home from "../pages/Home/Home.jsx";
import Atlas from "../pages/Atlas/Atlas.jsx";
import Data from "../pages/Data/Data.jsx";
import "./styles.css";

function App() {
  return (
    <Router>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Home />} />
          <Route path="/atlas" element={<Atlas />} />
          <Route path="/data" element={<Data />} />
        </Route>
      </Routes>
    </Router>
  );
}

export default App;
