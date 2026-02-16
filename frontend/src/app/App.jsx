import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import Layout from "./Layout.jsx";
import Home from "../pages/Home/Home.jsx";
import Atlas from "../pages/Atlas/Atlas.jsx";
import Data from "../pages/Data/Data.jsx";
import "./styles.css";
import AIprompt from "../pages/AI prompt/AI prompt.jsx";
import TwoDBrain from "../pages/2D-brain/2Dbrain.jsx";
import Atlas2D from "../pages/Atlas2D.jsx";
import SagittalView from "../components/SagittalView.jsx";
import CoronalView from "../components/CoronalView.jsx";
import TransverseView from "../components/TransverseView.jsx";


function App() {
  return (
    <Router>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Home />} />
          <Route path="/atlas" element={<Atlas />} />
          <Route path="/atlas-2d" element={<Atlas2D />} />
          <Route path="/data" element={<Data />} />
          <Route path="/ai-prompt" element={<AIprompt />} />
          <Route path="/2D-brain" element={<TwoDBrain />} />
          <Route path="/sagittal" element={<SagittalView />} />
          <Route path="/coronal" element={<CoronalView />} />
          <Route path="/transverse" element={<TransverseView />} />
        </Route>
      </Routes>
    </Router>
  );
}

export default App;
