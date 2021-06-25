import axios from 'axios';
import { ODataBatchRepository } from "./BatchRepository";

export class ODataBatchAxiosRepository implements ODataBatchRepository {

    async send(url, batchRequest, config) {

        return await axios.post(url, batchRequest, config);
    }
}