import { useState, useRef, useEffect } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  ProgressBar,
  Button,
  Banner,
  Scrollable,
  Box,
  Divider,
  Icon
} from "@shopify/polaris";
import { FolderIcon } from "@shopify/polaris-icons";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};

export default function Index() {
  const shopify = useAppBridge();
  const fileInputRef = useRef(null);

  const [filesBySku, setFilesBySku] = useState({});
  const [skuStatus, setSkuStatus] = useState({});
  const [overallStatus, setOverallStatus] = useState("idle"); // idle | resolving | ready | uploading | completed
  const [logs, setLogs] = useState([]);
  const [progress, setProgress] = useState({ total: 0, current: 0 });
  const logsEndRef = useRef(null);

  const addLog = (msg, type = "info") => {
    setLogs((prev) => [...prev, { msg, type, time: new Date().toLocaleTimeString() }]);
  };

  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs]);

  const handleDirectorySelect = async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    setLogs([]);
    const grouped = {};
    let totalImages = 0;

    files.forEach((file) => {
      const parts = file.webkitRelativePath.split("/");
      if (parts.length >= 2) {
        const sku = parts[parts.length - 2];
        if (!file.name.startsWith(".") && file.type.startsWith("image/")) {
          if (!grouped[sku]) grouped[sku] = [];
          grouped[sku].push(file);
          grouped[sku].sort((a, b) => a.name.localeCompare(b.name));
          totalImages++;
        }
      }
    });

    const skus = Object.keys(grouped);
    if (skus.length === 0) {
      addLog("No valid images found in subfolders.", "critical");
      return;
    }

    setFilesBySku(grouped);
    setOverallStatus("resolving");
    addLog(`Found ${skus.length} SKUs containing ${totalImages} images. Resolving Product IDs...`, "info");

    await resolveSkus(skus);
  };

  const resolveSkus = async (skus) => {
    const formData = new FormData();
    formData.append("skus", JSON.stringify(skus));

    try {
      const res = await fetch("/app/resolve-skus", { method: "POST", body: formData });
      const { results } = await res.json();

      const newSkuStatus = {};
      let foundCount = 0;
      let notFoundCount = 0;
      let totalFilesToUpload = 0;

      for (const sku of skus) {
        const productId = results[sku];
        if (productId) {
          newSkuStatus[sku] = { status: "resolved", productId };
          foundCount++;
          totalFilesToUpload += filesBySku[sku]?.length || 0;
        } else {
          newSkuStatus[sku] = { status: "not_found", productId: null };
          notFoundCount++;
          addLog(`Warning: Product not found for SKU "${sku}". Skipping...`, "warning");
        }
      }

      setSkuStatus(newSkuStatus);
      setProgress({ total: totalFilesToUpload, current: 0 });
      setOverallStatus("ready");
      addLog(`Resolution complete. ${foundCount} SKUs found, ${notFoundCount} missing. Ready to upload.`, "success");
    } catch (e) {
      addLog(`Error resolving SKUs: ${e.message}`, "critical");
      setOverallStatus("error");
    }
  };

  const handleUpload = async () => {
    setOverallStatus("uploading");
    const skusToUpload = Object.keys(filesBySku).filter((sku) => skuStatus[sku]?.status === "resolved");

    addLog(`Starting upload for ${progress.total} images across ${skusToUpload.length} SKUs.`, "info");
    let currentUpload = 0;

    for (const sku of skusToUpload) {
      const files = filesBySku[sku];
      const productId = skuStatus[sku].productId;

      setSkuStatus((prev) => ({ ...prev, [sku]: { ...prev[sku], status: "uploading" } }));
      let skuSuccess = true;

      for (const file of files) {
        addLog(`[${sku}] Uploading ${file.name}...`, "info");

        const formData = new FormData();
        formData.append("productId", productId);
        formData.append("file", file);
        formData.append("filename", file.name);

        try {
          const res = await fetch("/app/upload-image", { method: "POST", body: formData });
          if (res.ok) {
            const data = await res.json();
            if (data.success) {
              addLog(`[${sku}] Successfully uploaded ${file.name}`, "success");
            } else {
              addLog(`[${sku}] Failed to upload ${file.name}: ${data.error}`, "critical");
              skuSuccess = false;
            }
          } else {
            addLog(`[${sku}] Server error uploading ${file.name}`, "critical");
            skuSuccess = false;
          }
        } catch (e) {
          addLog(`[${sku}] Exception uploading ${file.name}: ${e.message}`, "critical");
          skuSuccess = false;
        }

        currentUpload++;
        setProgress((prev) => ({ ...prev, current: currentUpload }));
      }

      setSkuStatus((prev) => ({
        ...prev,
        [sku]: { ...prev[sku], status: skuSuccess ? "success" : "error" },
      }));
    }

    setOverallStatus("completed");
    addLog("Upload process completed.", "success");
    if (shopify) shopify.toast.show("Upload complete!");
  };

  const reset = () => {
    setFilesBySku({});
    setSkuStatus({});
    setOverallStatus("idle");
    setLogs([]);
    setProgress({ total: 0, current: 0 });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const totalSkus = Object.keys(filesBySku).length;
  const resolvedSkus = Object.values(skuStatus).filter((s) => s.status === "resolved" || s.status === "success" || s.status === "uploading").length;
  const progressPercent = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
    <Page title="Image Bulk Uploader">
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            {overallStatus === "idle" && (
              <Card>
                <BlockStack gap="400" align="center" inlineAlign="center">
                  <Box padding="500">
                    <BlockStack gap="400" align="center">
                      <Icon source={FolderIcon} tone="base" />
                      <Text variant="headingLg" as="h2" alignment="center">
                        Select Image Folder
                      </Text>
                      <Text variant="bodyMd" tone="subdued" alignment="center">
                        Choose a main folder containing subfolders named by SKU.
                        <br />
                        Example: Images / SKU-123 / front.jpg
                      </Text>
                      <Button onClick={() => fileInputRef.current?.click()} size="large">
                        Choose Folder
                      </Button>
                      <input
                        type="file"
                        webkitdirectory="true"
                        directory="true"
                        multiple
                        onChange={handleDirectorySelect}
                        ref={fileInputRef}
                        style={{ display: "none" }}
                      />
                    </BlockStack>
                  </Box>
                </BlockStack>
              </Card>
            )}

            {overallStatus !== "idle" && (
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-around">
                    <BlockStack gap="200" align="center">
                      <Text variant="heading2xl" as="h3">{totalSkus}</Text>
                      <Text variant="bodySm" tone="subdued">SKUS DETECTED</Text>
                    </BlockStack>
                    <BlockStack gap="200" align="center">
                      <Text variant="heading2xl" as="h3" tone={resolvedSkus === totalSkus ? "success" : "caution"}>
                        {resolvedSkus}
                      </Text>
                      <Text variant="bodySm" tone="subdued">SKUS MATCHED</Text>
                    </BlockStack>
                    <BlockStack gap="200" align="center">
                      <Text variant="heading2xl" as="h3">{progress.total}</Text>
                      <Text variant="bodySm" tone="subdued">IMAGES TOTAL</Text>
                    </BlockStack>
                  </InlineStack>

                  {(overallStatus === "uploading" || overallStatus === "completed") && (
                    <Box paddingBlockStart="400">
                      <BlockStack gap="200">
                        <InlineStack align="space-between">
                          <Text variant="bodyMd" fontWeight="bold">
                            {overallStatus === "uploading" ? "Uploading..." : "Completed"}
                          </Text>
                          <Text variant="bodyMd">
                            {progressPercent}% ({progress.current} / {progress.total})
                          </Text>
                        </InlineStack>
                        <ProgressBar progress={progressPercent} size="small" tone="primary" />
                      </BlockStack>
                    </Box>
                  )}

                  <Box paddingBlockStart="400">
                    <InlineStack align="center" gap="300">
                      {overallStatus === "ready" && (
                        <Button variant="primary" onClick={handleUpload} disabled={resolvedSkus === 0}>
                          Start Upload ({progress.total} Images)
                        </Button>
                      )}
                      <Button onClick={reset}>Start Over</Button>
                    </InlineStack>
                  </Box>
                </BlockStack>
              </Card>
            )}
          </BlockStack>
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            <Box padding="400" borderBottomWidth="025" borderColor="border">
              <Text variant="headingMd" as="h3">Process Log</Text>
            </Box>
            <Box background="bg-surface-secondary" minHeight="300px">
              <Scrollable style={{ height: "300px", padding: "1rem" }}>
                <BlockStack gap="100">
                  {logs.map((log, index) => {
                    const tones = {
                      info: "base",
                      success: "success",
                      warning: "caution",
                      critical: "critical"
                    };
                    return (
                      <Text key={index} variant="bodySm" tone={tones[log.type] || "base"}>
                        <span style={{ color: "var(--p-color-text-subdued)", marginRight: "8px" }}>
                          [{log.time}]
                        </span>
                        {log.msg}
                      </Text>
                    );
                  })}
                  <div ref={logsEndRef} />
                </BlockStack>
              </Scrollable>
            </Box>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
