import { BrowserRouter as Router, Routes, Route } from 'react-router-dom'
import Game from './pages/Game'
import './App.css'

function RootBoundary() {
  // When at root, redirect to a generic Home or logic inside Game handles it
  // Since user wants a single page, we can just load the Game component and handle "no ID" locally.
  return <Game />
}

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<RootBoundary />} />
        <Route path="/game/:id" element={<Game />} />
      </Routes>
    </Router>
  )
}

export default App
