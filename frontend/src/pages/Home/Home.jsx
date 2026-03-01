import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Brain, Search, Layers, ChevronRight } from "lucide-react";
import { useNavigate } from "react-router-dom";

function Home() {
    const navigate = useNavigate();

    const features = [
        {
            icon: <Layers className="w-6 h-6 text-blue-400" />,
            title: "3-Plane Viewer",
            description: "Explore sagittal, coronal, and transverse views simultaneously with synchronized slice navigation.",
            badge: "Interactive"
        },
        {
            icon: <Search className="w-6 h-6 text-purple-400" />,
            title: "Region Search",
            description: "Search and highlight any brain region by name with real-time suggestions as you type.",
            badge: "Smart Search"
        },
        {
            icon: <Brain className="w-6 h-6 text-pink-400" />,
            title: "AI Assistant",
            description: "Ask neuroscience questions and let AI guide you to the relevant brain regions automatically.",
            badge: "AI Powered"
        }
    ];

    return (
        <div className="min-h-screen bg-gray-950 text-white">

            {/* Hero */}
            <div className="flex flex-col items-center justify-center text-center px-6 py-24 bg-gradient-to-b from-blue-950/40 to-gray-950">
                <div className="flex items-center gap-3 mb-6">
                    <Brain className="w-12 h-12 text-blue-400" />
                    <h1 className="text-5xl font-bold tracking-tight">Brain Atlas</h1>
                </div>
                <p className="text-gray-400 text-lg max-w-xl mb-10">
                    Explore mouse brain regions interactively using the Allen Brain Atlas.
                    Visualize structures, search regions, and query with AI.
                </p>
                <div className="flex gap-4">
                    <Button
                        size="lg"
                        className="bg-blue-600 hover:bg-blue-500 text-white gap-2"
                        onClick={() => navigate('/2d-brain')}
                    >
                        Open Viewer <ChevronRight className="w-4 h-4" />
                    </Button>
                    <Button
                        size="lg"
                        variant="outline"
                        className="border-gray-600 text-gray-300 hover:bg-gray-800"
                        onClick={() => window.open('https://atlas.brain-map.org/', '_blank')}
                    >
                        Allen Brain Atlas
                    </Button>
                </div>
            </div>

            {/* Feature Cards */}
            <div className="max-w-5xl mx-auto px-6 py-16">
                <h2 className="text-2xl font-semibold text-center text-gray-200 mb-10">What you can do</h2>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {features.map((f) => (
                        <Card key={f.title} className="bg-gray-900 border-gray-800 hover:border-blue-700 transition-colors">
                            <CardHeader className="pb-2">
                                <div className="flex items-center justify-between mb-2">
                                    {f.icon}
                                    <Badge variant="secondary" className="text-xs bg-gray-800 text-gray-300">
                                        {f.badge}
                                    </Badge>
                                </div>
                                <CardTitle className="text-white text-lg">{f.title}</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <CardDescription className="text-gray-400 text-sm leading-relaxed">
                                    {f.description}
                                </CardDescription>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            </div>

            {/* Footer */}
            <div className="text-center py-10 text-gray-600 text-sm border-t border-gray-800">
                Built with Allen Brain Atlas API · Mouse Brain Parcellation Data
            </div>
        </div>
    );
}

export default Home;