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
  Icon,
  DataTable,
  Select
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
  const [failedUploads, setFailedUploads] = useState([]);
  const [productStatus, setProductStatus] = useState("ALL");
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
    setFailedUploads([]);
    const grouped = {};
    let totalImages = 0;
    const newFailed = [];

    files.forEach((file) => {
      const parts = file.webkitRelativePath.split("/");
      if (parts.length >= 2) {
        const sku = parts[parts.length - 2];
        if (!file.name.startsWith(".")) {
          if (file.type.startsWith("image/")) {
            if (!grouped[sku]) grouped[sku] = [];
            grouped[sku].push(file);
            grouped[sku].sort((a, b) => a.name.localeCompare(b.name));
            totalImages++;
          } else {
            newFailed.push({ sku, file: file.name, reason: "Invalid file format" });
          }
        }
      }
    });

    const skus = Object.keys(grouped);
    if (skus.length === 0) {
      if (newFailed.length > 0) {
        setFailedUploads(newFailed);
        setOverallStatus("completed");
      }
      addLog("No valid images found in subfolders.", "critical");
      return;
    }

    setFailedUploads(newFailed);
    setFilesBySku(grouped);
    setOverallStatus("resolving");
    addLog(`Found ${skus.length} SKUs containing ${totalImages} images. Resolving Product IDs...`, "info");

    await resolveSkus(skus);
  };

  const resolveSkus = async (skus) => {
    const formData = new FormData();
    formData.append("skus", JSON.stringify(skus));
    formData.append("statusFilter", productStatus);

    try {
      const res = await fetch("/app/resolve-skus", { method: "POST", body: formData });
      const { results } = await res.json();

      const newSkuStatus = {};
      let foundCount = 0;
      let notFoundCount = 0;
      let totalFilesToUpload = 0;

      for (const sku of skus) {
        const result = results[sku];
        
        if (result && result.id) {
          newSkuStatus[sku] = { status: "resolved", productId: result.id };
          foundCount++;
          totalFilesToUpload += filesBySku[sku]?.length || 0;
        } else if (result && result.error === "status_mismatch") {
          newSkuStatus[sku] = { status: "not_found", productId: null };
          notFoundCount++;
          addLog(`Warning: Product for SKU "${sku}" is ${result.actualStatus}, but filter is ${productStatus}. Skipping...`, "warning");
          setFailedUploads((prev) => [...prev, { sku, file: "All files", reason: `Skipped: Product is ${result.actualStatus}` }]);
        } else {
          newSkuStatus[sku] = { status: "not_found", productId: null };
          notFoundCount++;
          addLog(`Warning: Product not found for SKU "${sku}". Skipping...`, "warning");
          setFailedUploads((prev) => [...prev, { sku, file: "All files", reason: "SKU not found in Shopify" }]);
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
              const errorMessage = data.error || "API error";
              addLog(`[${sku}] Failed to upload ${file.name}: ${errorMessage}`, "critical");
              setFailedUploads((prev) => [...prev, { sku, file: file.name, reason: errorMessage }]);
              skuSuccess = false;
            }
          } else {
            addLog(`[${sku}] Server error uploading ${file.name}`, "critical");
            setFailedUploads((prev) => [...prev, { sku, file: file.name, reason: "Server error / Upload timeout" }]);
            skuSuccess = false;
          }
        } catch (e) {
          addLog(`[${sku}] Exception uploading ${file.name}: ${e.message}`, "critical");
          setFailedUploads((prev) => [...prev, { sku, file: file.name, reason: `Exception: ${e.message}` }]);
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
    setFailedUploads([]);
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

                      <Box paddingBlockStart="200" paddingBlockEnd="200" width="100%" maxWidth="300px">
                        <Select
                          label="Target Product Status"
                          options={[
                            {label: 'All Products', value: 'ALL'},
                            {label: 'Active Only', value: 'ACTIVE'},
                            {label: 'Draft Only', value: 'DRAFT'},
                            {label: 'Archived Only', value: 'ARCHIVED'},
                          ]}
                          onChange={setProductStatus}
                          value={productStatus}
                        />
                      </Box>

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

        {overallStatus === "completed" && failedUploads.length > 0 && (
          <Layout.Section>
            <Card padding="0">
              <Box padding="400" borderBottomWidth="025" borderColor="border">
                <Text variant="headingMd" as="h3" tone="critical">Failed / Skipped Uploads</Text>
              </Box>
              <DataTable
                columnContentTypes={['text', 'text', 'text']}
                headings={['SKU', 'File', 'Reason for failure']}
                rows={failedUploads.map(f => [f.sku, f.file, f.reason])}
              />
            </Card>
          </Layout.Section>
        )}

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
